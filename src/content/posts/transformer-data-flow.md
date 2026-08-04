---
title: "从 Transformer 到 CLIP 与扩散模型：用数据流读懂文生图"
published: 2026-07-28
description: "从神经网络训练、RNN 与 Attention 出发，串联 Transformer、CLIP 图文对齐、扩散模型和 LoRA 的完整数据流。"
tags: ["Transformer","扩散模型","多模态","AI 基础"]
category: "AI 基础"
---

<a id="intro"></a>

## 1. 为什么要从数据流理解 Transformer

很多人第一次学习 Transformer，会直接撞上 Q、K、V、Multi-Head、LayerNorm、Softmax 这些词。结果每个词都像懂了一点，但合起来仍然不知道模型到底在做什么。

更好的入口是数据流：**一份输入如何变成预测，预测如何产生错误，错误如何反过来修改模型，序列模型又为什么需要 Attention。**

本文路线是：

```
传统神经网络训练 → 语言是序列问题 → RNN 顺序读取 → RNN 的长依赖和并行瓶颈 → Attention 直接连接任意位置 → Transformer 数据流
```

> **💡 核心观点：**Transformer 不是凭空冒出来的。它是在解决序列建模中“信息传得远、传得慢、容易丢”的问题。

<a id="training"></a>

## 2. 传统神经网络是如何训练的

先不谈语言，只看一个最普通的神经网络。它的目标很简单：给一个输入，输出一个预测；预测错了，就调整内部参数，让下次更接近正确答案。

```text
输入数据例如图片 / 数字 / 文本特征 → 神经网络一堆可调参数 → 预测结果模型猜答案 → 损失函数预测和答案差多少 → 反向传播告诉参数怎么改 ↺
```

> **图示：标准神经网络训练示意图**
>
> 输入层、两层隐藏层、输出层和损失函数组成一个前馈神经网络。前向信号从左到右产生预测，损失信号再反向传播更新权重。

### 2.1 参数是什么？

参数可以理解成模型里的“旋钮”。每个旋钮都会影响输出结果。训练前，这些旋钮通常还不合适；训练过程就是不断调整它们。

### 2.2 损失函数是什么？

损失函数负责把“错得多严重”变成一个数字。比如分类任务中，如果正确答案是“猫”，模型却很自信地预测成“狗”，损失就会比较大。

### 2.3 反向传播是什么？

反向传播做的事情是：从错误出发，沿着计算路径往回走，估计每个参数对错误贡献了多少，然后把参数往更好的方向调一点。反向传播是现代神经网络训练的关键方法之一，Rumelhart、Hinton 和 Williams 在 1986 年的论文中系统展示了这种方法如何让多层网络学习内部表示 [[3]](#ref3)。

```text
训练循环 = 前向预测 → 计算损失 → 反向传播 → 更新参数 → 再来一轮
```

到这里，普通神经网络的训练逻辑已经清楚了。但语言有一个额外麻烦：**语言不是一个孤立输入，而是一串有顺序的符号。**

<a id="sequence"></a>

## 3. 语言为什么是序列问题

看两句话：

```
猫追狗
狗追猫
```

它们包含同样的字，但意思完全相反。区别不在“有哪些字”，而在“字的顺序”。

再看一句稍长的话：

```
小猫追着蝴蝶，因为它很好奇。
```

要理解“它”指谁，模型需要记住前文内容，还要判断词与词之间的关系。这就让语言建模变成了序列建模：输入不是一个点，而是一条从左到右展开的数据流。

```text
第 1 个词小猫 → 第 2 个词追着 → 第 3 个词蝴蝶 → 第 4 个词因为 → 第 5 个词它 → 第 6 个词好奇
```

这引出了早期处理序列的主力方法：RNN。

<a id="rnn"></a>

## 4. RNN 如何处理序列

RNN，循环神经网络，直觉非常自然：一句话从左到右读，每读一个 token，就更新一次“记忆状态”。

```text
输入 x1小猫 → 状态 h1记住小猫 → 输入 x2追着 → 状态 h2小猫 + 追着 → 输入 x3蝴蝶 → 状态 h3继续更新记忆
```

> **图示：RNN 顺序读取神经网络图**
>
> 上方 token 逐步输入同一个循环单元，下方隐藏状态从 h1 传到 h6。记忆信号必须沿状态链顺序传递。

它的核心数据流可以写成：

```
当前输入 x_t + 上一步记忆 h_(t-1) → 当前记忆 h_t
```

这很像人读句子：读到后面时，脑子里带着前面读过的内容。

> **RNN 的优点：**它把“顺序”天然纳入计算过程，适合处理时间序列和文本序列。

<a id="rnn-limits"></a>

## 5. RNN 的局限性：信息传得远、传得慢、容易丢

RNN 的直觉很好，但它有几个关键问题。

### 5.1 长距离依赖：远处信息要一站一站传过来

如果第 1 个词的信息要影响第 50 个词，它必须经过 h1 → h2 → h3 →... → h50 这条长链。链越长，信息越容易变弱、变形或被覆盖。

```text
重要信息第 1 个词 → h2 → h3 → ... → h50可能已经模糊
```

### 5.2 梯度问题：训练信号也要穿过长链

训练时，错误信号需要从后面反传到前面。如果路径很长，梯度可能变得很小，导致前面位置学得很慢；也可能变得很大，导致训练不稳定。这类长期依赖问题也是 LSTM 被提出的重要背景之一 [[4]](#ref4)。

### 5.3 并行性差：后一步依赖前一步

RNN 的 h3 依赖 h2，h2 又依赖 h1。这意味着很多计算必须按顺序做，难以像矩阵运算那样大规模并行。

> **RNN 的瓶颈：**它把序列压进一条单线记忆流里。距离越远，信息越难保真；序列越长，计算越难并行。

<a id="attention-why"></a>

## 6. Attention 为什么出现：不要把整句话压成一个瓶子

早期 encoder-decoder 模型常把输入句子压缩成一个固定长度向量，再让 decoder 根据这个向量生成输出。对短句还可以，对长句就像把一本书塞进一张便利贴。

```text
长输入句子 → Encoder → 固定长度向量信息瓶颈 → Decoder 输出
```

Bahdanau、Cho 和 Bengio 在神经机器翻译中引入了 attention / alignment 机制，让 decoder 在生成每个目标词时，可以动态关注输入句子的相关部分，而不是只依赖一个固定长度向量 [[5]](#ref5)。

> **Attention 的关键想法：**生成某个词时，不必只看一个总摘要；可以回头查看输入序列中最相关的位置。

<a id="attention-how"></a>

## 7. Attention 如何解决问题：让任意两个位置直接连接

Attention 的核心变化是：信息不再只能沿着 RNN 的链条一站一站传，而是可以让当前位置直接查看所有位置。

```text
RNN 的路径第 1 个词 → 第 2 个词 → 第 3 个词 → ... → 第 50 个词。远距离信息要走很多步。Attention 的路径第 50 个词可以直接给第 1 个词分配权重，一步拿到相关信息。当前 token → 计算相关性 → 选择重要位置 → 加权汇总上下文
```

> **图示：Self-Attention QKV 神经网络图**
>
> 当前 token 它生成 Query，所有 token 生成 Key 和 Value。Query 与 Key 计算权重，再按权重汇总 Value，形成它的新上下文向量。

它解决了三个核心问题：

| 问题 | RNN 的困难 | Attention 的改善 |
| --- | --- | --- |
| 长距离依赖 | 信息要经过很多隐藏状态传递 | 任意位置可以直接建立连接 |
| 固定向量瓶颈 | 整句信息被压进一个摘要向量 | 每一步都可以动态查看相关位置 |
| 并行计算 | 后一步依赖前一步，难以并行 | 同一层中多个位置的相关性可用矩阵并行计算 |

Transformer 的关键进一步推进是：如果 Attention 已经能处理序列中的关系，那能不能干脆把 recurrence 去掉，主要依赖 attention 来建模序列？Vaswani 等人在 *Attention Is All You Need* 中给出的答案就是 Transformer [[1]](#ref1)。

<a id="overview"></a>

## 8. Transformer 总览：一条语义加工流水线

现在再看 Transformer 的完整数据流，就不突兀了：它先把文字变成向量，再用 Attention 让每个位置直接吸收其他位置的信息。

```text
原始文本我喜欢机器学习 → Token → Token ID → Embedding → 位置编码 → Attention → 多层 Block → Logits / Softmax → 输出文字
```

> **图示：Transformer 端到端模块网络图**
>
> 文本依次变成 token、token ID、embedding 向量、带位置的向量，再经过 attention、多层 block、logits 和 softmax，最后得到输出 token。

| 层级 | 数据形态 | 它回答的问题 |
| --- | --- | --- |
| 第 0 层 | 原始文本 | 用户输入了什么？ |
| 第 1 层 | Token | 这句话被切成哪些小片段？ |
| 第 2 层 | Token ID | 每个片段对应哪个数字编号？ |
| 第 3 层 | Embedding 向量 | 每个片段如何变成可计算的语义坐标？ |
| 第 4 层 | 加了位置的向量 | 模型如何知道词的顺序？ |
| 第 5 层 | Attention 后的上下文向量 | 每个词该关注句子里的哪些词？ |
| 第 6 层 | 多层 Transformer Block 输出 | 信息如何被反复提炼？ |
| 第 7 层 | Logits / 概率分布 | 下一个 token 可能是什么？ |
| 第 8 层 | 输出文本 | 数字结果如何变回人能读的文字？ |

<a id="tokens"></a>

## 9. 文本到 Token：先把句子切成小片段

模型不能直接处理字符串。第一步要用 tokenizer 把文本切成模型词表里存在的小单位，也就是 token。

```
我喜欢机器学习
↓
我 / 喜欢 / 机器 / 学习
```

```text
原始文本 → Tokenizer → Token 序列
```

Token 不一定等于一个汉字，也不一定等于一个词。它只是模型词表中的最小处理单位。

<a id="embedding"></a>

## 10. Token 到向量：从编号到语义坐标

每个 token 会先变成 ID，再通过 embedding table 查到一串小数。

```
我     → 101  → [0.12, -0.08, 0.31, ...]
喜欢   → 872  → [0.44,  0.10, -0.27, ...]
机器   → 1599 → [-0.21, 0.72, 0.05, ...]
学习   → 3322 → [0.33, -0.19, 0.48, ...]
```

> **⚠️ 注意：**ID 只是门牌号，不是语义。真正参与计算的是 embedding 向量。

<a id="position"></a>

## 11. 加入位置：让模型知道顺序

Attention 本身擅长比较“谁和谁相关”，但不天然知道“谁在前谁在后”。如果不给位置信息，模型看到的更像一袋 token：它能知道有哪些词，却很难稳定地区分“我喜欢你”和“你喜欢我”。所以 Transformer 必须把顺序信息注入到计算里。

### 11.1 绝对位置编码：给每个位置一个坐标标签

原始 Transformer 使用 positional encoding 来提供序列顺序信息 [[1]](#ref1)。最直观的做法是：第 1 个位置、第 2 个位置、第 3 个位置……各自有一个位置向量，然后把它加到 token embedding 上。

```text
Token Embedding词的语义 + Position Encoding第几个位置 → 带位置的向量语义 + 顺序
```

```
第 3 个 token 的输入向量
= token embedding + position embedding(3)
```

类比一下：token embedding 像演员本身，位置编码像舞台站位。只有演员和站位结合起来，句子才有结构。

### 11.2 绝对位置编码的局限性

绝对位置编码能解决“模型不知道顺序”的问题，但它也有局限。第一，它强调的是“我在第几个位置”，而 Attention 真正经常需要的是“我和另一个 token 相隔多远”。例如理解“它”指代谁时，第 20 个词和第 23 个词之间的距离，往往比“第 20 个词”这个绝对编号更关键。

第二，绝对位置编码把位置信息较早混进 token 表示里。后面计算 Q、K、V 时，模型需要自己学会从混合后的向量里恢复位置关系。这样不是不能做，但相对位置关系并没有直接出现在 Attention 分数里。

第三，当序列长度超过训练时常见长度时，绝对位置编号可能变得不够自然。模型训练时常见的是某个位置范围，推理时突然看到更长的位置，位置表示和注意力模式可能更难泛化。

| 问题 | 绝对位置编码的表现 | 为什么会影响序列建模 |
| --- | --- | --- |
| 相对距离 | 直接告诉模型“第几个位置” | 但 Attention 常需要知道“两个 token 隔多远” |
| 注入位置 | 先把位置加到 embedding 里 | Q/K 匹配时还要间接学出位置关系 |
| 长序列泛化 | 位置编号依赖训练中见过的范围和模式 | 上下文变长时，位置模式可能不够平滑 |

### 11.3 旋转位置编码 RoPE：把位置写进 Q/K 的角度

旋转位置编码 Rotary Position Embedding，简称 RoPE，是很多现代大语言模型常用的位置编码方式。它不是简单地把位置向量加到 token embedding 上，而是在计算 Attention 之前，按照 token 的位置去旋转 Query 和 Key 向量的一部分维度 [[6]](#ref6)。

```text
Token 向量语义坐标 → 生成 Q / K准备匹配↻按位置旋转位置越靠后角度越大 → QK 点积带相对距离
```

可以把向量的相邻两个维度看成一个二维平面。RoPE 会把 Q 和 K 拆成很多这样的二维小平面；第 m 个位置的 token，就把自己的 Q/K 在这些平面里旋转一个与 m 相关的角度。

> **图示：RoPE 的二维几何向量图**
>
> 同一个二维向量在不同位置会旋转到不同角度。第 m 个位置的 Query 和第 n 个位置的 Key 做点积时，两个旋转角度的差对应相对距离。

```
普通点积只看两个向量本身：
q = [q1, q2],  k = [k1, k2]
score = q · k = q1*k1 + q2*k2

RoPE 先按位置旋转 Q / K：
R(t) = [ cos(t)  -sin(t) ]
       [ sin(t)   cos(t) ]

q_m = R(mθ) q
k_n = R(nθ) k

再做点积：
score_rope = q_m · k_n
           = (R(mθ)q)^T (R(nθ)k)
           = q^T R((n-m)θ) k

令 Δ = (n-m)θ，二维展开为：
score_rope =
  (q1*k1 + q2*k2) * cos(Δ)
  + (q2*k1 - q1*k2) * sin(Δ)
```

这条展开式更直观：第一项 `q1*k1 + q2*k2` 就是普通点积，但它会被 `cos(Δ)` 调制；第二项是旋转后多出来的交叉项，并由 `sin(Δ)` 控制。这里的 `Δ=(n-m)θ` 只和两个 token 的相对距离有关，所以 Attention 分数不只看语义是否匹配，还显式带上了“第 n 个位置相对第 m 个位置隔了多远”。RoFormer 论文把这一点概括为：RoPE 用旋转矩阵编码绝对位置，同时在 self-attention 里引入显式的相对位置依赖 [[6]](#ref6)。

### 11.4 为什么 RoPE 更好

RoPE 的优势不在于“看起来更复杂”，而在于它把位置关系放在 Attention 最需要的位置：Q 和 K 的匹配过程里。Attention 的核心问题是“当前位置应该关注哪个位置”，所以直接让 Q/K 点积感知相对距离，比只在输入层贴一个绝对位置标签更贴近任务。

| 比较点 | 绝对位置编码 | RoPE |
| --- | --- | --- |
| 位置含义 | 强调第几个位置 | 点积中自然体现两个位置的距离 |
| 作用位置 | 加在输入 embedding 上 | 作用在 Attention 的 Q/K 匹配上 |
| 关系建模 | 相对关系需要模型间接学出来 | 相对位置依赖直接进入 attention score |
| 长上下文 | 位置模式可能更依赖训练长度 | 旋转角度随位置连续变化，更适合外推和长距离关系建模 |

> **关键点：**绝对位置编码是在输入里告诉模型“这个 token 在第几个位置”；RoPE 是在 Attention 匹配时告诉模型“这两个 token 的语义是否相关，以及它们相隔多远”。这就是它在现代 Transformer 中常见的原因。

<a id="self-attention"></a>

## 12. Self-Attention：让每个 token 带上上下文

看这句话：

```
小猫追着蝴蝶，因为它很好奇。
```

“它”指谁？人会根据上下文猜测，“它”大概率指“小猫”。模型也要做类似的事：处理“它”这个 token 时，不能只看“它”本身，还要看前面的“小猫”“追着”“蝴蝶”等词。

```text
1. 生成 Query当前 token 想找什么信息？2. 匹配 Keys其他 token 能提供什么信息？3. 汇总 Values按权重拿走真正的内容。
```

| 名称 | 全称 | 直观理解 |
| --- | --- | --- |
| Q | Query | 我现在想找什么信息？ |
| K | Key | 我这里有什么信息可被匹配？ |
| V | Value | 如果你关注我，我实际贡献什么内容？ |

Self-Attention 的输出不是“重要词列表”，而是每个 token 的新向量：这个新向量已经混入了上下文信息。

### 12.1 训练时 Q/K/V 是怎么学出来的

Q、K、V 不是人工写好的规则，也不是固定词典。它们是输入向量乘上三组可训练参数得到的结果。真正被训练更新的是 `Wq`、`Wk`、`Wv` 这些投影矩阵；训练早期它们还很粗糙，随着预测错误不断反传，才逐渐学会“什么该查询、什么该匹配、什么内容值得传递”。

```
输入向量矩阵：X

Q = X Wq
K = X Wk
V = X Wv

Attention 分数：
S = Q K^T / sqrt(dk)

注意力权重：
A = softmax(S)

上下文输出：
O = A V
```

下面是一段只依赖 `numpy` 的最简 Self-Attention 实现。它不包含多头、不包含 mask、不包含 LayerNorm，只保留最核心的数据流：投影出 `Q/K/V`，计算相关性，softmax 成权重，再加权汇总 `V`。

```
import numpy as np

def softmax(x, axis=-1):
    x = x - np.max(x, axis=axis, keepdims=True)  # 防止 exp 数值过大
    exp_x = np.exp(x)
    return exp_x / np.sum(exp_x, axis=axis, keepdims=True)

def self_attention(X, Wq, Wk, Wv):
    # X:  [seq_len, d_model]，一整句话的 token 向量
    # Wq/Wk/Wv: 可训练投影矩阵
    Q = X @ Wq
    K = X @ Wk
    V = X @ Wv

    dk = K.shape[-1]
    scores = (Q @ K.T) / np.sqrt(dk)   # [seq_len, seq_len]
    weights = softmax(scores, axis=-1) # 每一行表示当前 token 看所有 token 的权重
    output = weights @ V               # [seq_len, d_value]
    return output, weights

# 示例：3 个 token，每个 token 是 4 维向量
np.random.seed(0)
X = np.random.randn(3, 4)
Wq = np.random.randn(4, 4)
Wk = np.random.randn(4, 4)
Wv = np.random.randn(4, 4)

O, A = self_attention(X, Wq, Wk, Wv)
print("attention weights:\\n", A)
print("output:\\n", O)
```

输出里的 `A` 就是 attention 权重矩阵。第 `i` 行表示第 `i` 个 token 在更新自己时，分别从所有 token 那里拿多少信息；`O` 则是混入上下文后的新 token 向量。

> **图示：Self-Attention 训练时的多 token 数据流和参数更新**
>
> 每个 token 都用共享的 Wq Wk Wv 投影出自己的 q k v。每个 query 查询所有 keys，得到权重后汇总所有 values。损失梯度反向更新共享投影参数。

这张图的关键是：每个 token 都会生成自己的 `q_i/k_i/v_i`，但它们使用的是同一组共享参数 `Wq/Wk/Wv`。前向传播时，每个 `q_i` 都会和所有 `k_j` 做匹配，得到一行 attention 权重，再用这行权重汇总所有 `v_j`；反向传播时，预测误差沿着 `O = A V`、`A = softmax(QK^T)` 回到所有 `q/k/v`，最后汇总成对共享参数 `Wq/Wk/Wv` 的更新。

| 参数 | 前向时的作用 | 训练时如何被更新 |
| --- | --- | --- |
| `Wq` | 把 token 向量投影成 Query，决定当前位置“想找什么” | 如果模型关注错了位置，梯度会调整 Wq，让 Query 更容易提出正确查询 |
| `Wk` | 把 token 向量投影成 Key，决定每个位置“能被怎样匹配” | 如果该被关注的位置没有被匹配上，梯度会调整 Wk，让 Key 更容易被相关 Query 找到 |
| `Wv` | 把 token 向量投影成 Value，决定被关注后实际贡献什么内容 | 如果汇总后的上下文对预测没帮助，梯度会调整 Wv，让 Value 携带更有用的信息 |

```
一次训练迭代里的 Self-Attention 数据流：

1. 前向：
   X = [x1; x2; x3; ...]
   Q = XWq, K = XWk, V = XWv
   Q 的每一行是一个 token 的 q_i
   K 的每一行是一个 token 的 k_i
   V 的每一行是一个 token 的 v_i
   A = softmax(QK^T / sqrt(dk))  # token × token 权重矩阵
   O = A V → 预测 logits → loss

2. 反向：
   loss 的梯度 → logits → O → A,V → Q,K
   所有 token 的梯度一起汇总到共享参数 Wq,Wk,Wv

3. 更新：
   Wq ← Wq - learning_rate * gradient(Wq)
   Wk ← Wk - learning_rate * gradient(Wk)
   Wv ← Wv - learning_rate * gradient(Wv)
```

> **训练视角下的 QKV：**Q/K/V 机制不是模型手写的“注意力规则”，而是一组可训练的投影。训练数据不断告诉模型哪些关注关系能降低 loss，参数更新就把这些关系写进 `Wq/Wk/Wv` 里。

<a id="multihead"></a>

## 13. Multi-Head Attention：多个角度看同一句话

一句话里可能同时有指代关系、动作关系、修饰关系和语气关系。一个 attention head 可能更关注指代，另一个关注动作，还有一个关注修饰。

```text
输入向量序列 → Head 1看指代Head 2看动作Head 3看修饰 → 拼接与融合 → 输出向量序列
```

这就是 Multi-Head Attention：用多个 attention head 并行观察同一批 token，然后把结果合并。

<a id="block"></a>

## 14. Transformer Block 如何加工信息

一个 Transformer Block 通常不只有 Attention。它还包含 Feed-Forward Network、残差连接和 LayerNorm 等结构。

```text
输入向量 → Multi-Head Attention跨 token 交换信息 → 残差 + LayerNorm保留信息并稳定数值 → Feed-Forward逐 token 深加工 → 输出向量
```

Attention 像开会，大家互相交流；Feed-Forward 像会后每个人自己整理笔记。残差连接给信息一条直达通道，LayerNorm 让数值更稳定。

<a id="decoder"></a>

## 15. Encoder、Decoder 与生成

原始 Transformer 是 encoder-decoder 结构，常用于机器翻译这类 sequence-to-sequence 任务 [[1]](#ref1)。后来很多模型只使用其中一部分结构。

| 形态 | 数据流 | 常见用途 | 直观理解 |
| --- | --- | --- | --- |
| Encoder-only | 输入 → 上下文表示 | 分类、理解、检索 | 读懂一段话 |
| Decoder-only | 已有文本 → 下一个 token | 续写、聊天、代码生成 | 接着往下写 |
| Encoder-decoder | 输入 → 表示 → 输出 | 翻译、摘要 | 先读懂，再改写 |

Decoder 生成文本时通常不能偷看未来答案。生成第 3 个 token 时，只能看第 1、2 个 token，不能看第 4 个 token。这叫 masked self-attention。

<a id="probability"></a>

## 16. 向量如何变成概率与输出

经过多层 Transformer Block 后，每个位置都有一个高层语义向量。如果模型要生成文本，它需要回答：下一个 token 最可能是什么？

```text
最后一层向量 → Linear映射到词表分数 → Logits每个 token 一个分数 → Softmax分数变概率 → 选择下一个 token
```

生成式模型通常不是一次性写完整答案，而是不断重复：读当前上下文 → 预测下一个 token → 拼回上下文 → 继续预测。

<a id="example"></a>

## 17. 文本 Transformer 的完整例子

现在用一句话把文本生成流程串起来。到第 16 节为止，模型的出口仍然是“下一个 token 的概率”。

```
输入：请解释机器学习
```

| 步骤 | 数据形态 | 示例 |
| --- | --- | --- |
| 1 | 原始文本 | `请解释机器学习` |
| 2 | Tokens | `请 / 解释 / 机器 / 学习` |
| 3 | Token IDs | `[311, 920, 1599, 3322]`，示意数字 |
| 4 | Embeddings | 每个 ID 查到一个向量 |
| 5 | 加位置 | 向量 + 第几个 token 的信息 |
| 6 | Self-Attention | “机器”和“学习”互相关联，“解释”影响任务意图 |
| 7 | 多层 Block | 不断提炼出“用户想要一个解释”的表示 |
| 8 | Logits | 对词表里每个 token 打分 |
| 9 | Softmax | 得到下一个 token 概率 |
| 10 | 输出 | 可能先生成“机器”，再生成“学习”，再生成“是”…… |

> **过渡问题：**如果输出不再是 token，而是一张图片，模型就不能只在词表里选下一个符号。它必须先理解文字描述对应怎样的视觉内容，再在连续的图像空间里生成结果。

<a id="image-generation-problem"></a>

## 18. 从文本生成到图像生成：输出空间变了

文本生成和图像生成的输入都可以是文字，但输出完全不同。文本模型面对的是离散词表：每一步从几万个 token 中选一个。图像模型面对的是二维像素或 latent 空间：颜色、形状、位置、风格都混在连续数值里。

| 任务 | 模型要处理的对象 | 输出方式 | 核心难点 |
| --- | --- | --- | --- |
| 文本生成 | Token 序列 | 逐步预测下一个 token | 上下文理解和语言概率 |
| 图像生成 | 像素 / latent 网格 | 逐步形成整张图像 | 语义、空间布局、纹理细节同时成立 |

所以从文本到图像会多出两个问题：第一，文字和图像如何表示到一起；第二，图像如何从噪声或 latent 中生成出来。前一个问题引出 CLIP，后一个问题引出扩散模型。

<a id="multimodal"></a>

## 19. 多模态的核心问题：文本和图像如何对齐

文本是一串 token，图像是二维网格。多模态学习的第一步不是生成，而是让模型知道“这句话”和“这张图”是否在说同一件事。

```text
文本描述a red apple → 文本 Encoder → 文本向量↘图像 → 图像 Encoder → 图像向量↗共享语义空间
```

如果一段文字和一张图片匹配，它们的向量应该靠近；如果不匹配，它们的向量应该远离。这个思想就是 CLIP 的起点。

<a id="clip-overview"></a>

## 20. CLIP 如何把图文对齐到同一语义空间

CLIP 的全称是 Contrastive Language-Image Pre-training。它不是简单地把“图片向量”和“文本向量”放在一起，而是先解决三个工程问题：输入形态不同、Encoder 输出维度可能不同、不同模态的向量尺度也可能不同。只有这些问题处理完，图文相似度才有数学意义 [[7]](#ref7)。

### 20.1 为什么不能直接比较图片和文字

原始图片通常是 `H × W × 3` 的像素网格，例如高度、宽度和 RGB 三个颜色通道。原始文本是一串字符或 token，例如 `a red apple`。这两种数据不仅长度不同，结构也不同：图片有二维空间邻接关系，文本有一维顺序关系。因此，CLIP 的第一步不是“比较”，而是先把两种输入各自变成模型能处理的向量序列。

| 对象 | 原始形态 | 预处理后 | 为什么需要这一步 |
| --- | --- | --- | --- |
| 图片 | 像素网格 `H × W × 3` | 缩放、裁剪、归一化，再送入图像 Encoder | 让不同尺寸、不同数值范围的图片进入统一输入格式 |
| 文本 | 字符串 | tokenize 成 token ID，再查 embedding | 让文字变成神经网络可计算的数字序列 |

### 20.2 Encoder 先各自理解，再投影到同一维度

图像 Encoder 和文本 Encoder 的内部结构可以不同，输出的中间表示也可以不同。真正用于图文比较的不是这些原始中间表示，而是经过一个可训练的 projection head 之后的向量。这个 projection head 可以理解成“接口适配器”：它把图像侧和文本侧都映射到同一个维度 `d`。

```
image_features = image_encoder(image_pixels)
text_features  = text_encoder(text_tokens)

image_embedding = image_features × W_image_projection  # -> d 维
text_embedding  = text_features  × W_text_projection   # -> d 维
```

如果一个向量是 768 维，另一个向量是 1024 维，它们不能直接做点积。投影层的作用就是让二者最终都变成同样长度的向量，例如都变成 `d` 维。维度相同之后，每个位置不再代表某个固定人工含义，而是模型训练出来的语义坐标。

> **图示：CLIP 从不同模态到同维语义向量的动画**
>
> 图片和文本先分别预处理，再经过各自 encoder，随后通过 projection head 映射到同一维度，归一化后用余弦相似度计算匹配程度。

### 20.3 “高维语义空间”到底是什么

可以把一个二维平面想成地图：每个点有横坐标和纵坐标。高维语义空间也是类似的，只是坐标不止 2 个，而是 `d` 个。一个 embedding 就是这个空间里的一个点或一个方向。训练前，这个空间没有稳定语义；训练后，模型会把“语义相近”的图文放到方向相近的位置。

这里的“语义”不是人工规定的某一维等于“颜色”、另一维等于“动物”。更准确地说，每一维都是模型为了降低训练损失学出来的隐含特征。单独看某一维通常不好解释，但整个向量的方向可以表达“这像不像一张红苹果照片”“这像不像一只猫在沙发上”。

### 20.4 为什么要归一化，为什么用相似度

投影之后，CLIP 通常会把图像向量和文本向量归一化，也就是把向量长度缩放为 1。这样比较两个向量时，重点就从“谁的数值更大”变成“两个方向是否接近”。方向越接近，说明语义越相似。

```text
相似度 = normalized_image_embedding · normalized_text_embedding
```

这个点积可以理解成余弦相似度：两个向量方向越一致，分数越高；方向差得越远，分数越低。于是，CLIP 可以对一张图片和很多句文本分别算分，也可以对一句文本和很多张图片分别算分。

### 20.5 对齐不是手写规则，而是训练出来的

CLIP 的训练数据里有大量图文配对。对于一张红苹果图片和文字 `a red apple`，模型会提高它们的相似度；对于这张图片和 `a blue car` 这类不匹配文本，模型会降低相似度。经过大量这样的更新，projection head 和两个 Encoder 会共同形成一个可比较的语义空间。

> **关键点：**所谓“对齐”，不是把图片硬翻译成文字，也不是人工规定每个维度的含义；而是通过训练让匹配图文在同一高维空间里的方向更接近，让不匹配图文方向更远。

<a id="clip-image-encoder"></a>

## 21. 图像 Encoder 如何工作

图像 Encoder 的任务是把一张图片变成一个全局语义向量。CLIP 论文中使用过 ResNet 路线，也使用过 Vision Transformer 路线；为了和前面的 Transformer 主线衔接，这里重点看 ViT 思路 [[8]](#ref8)。

### 21.1 图片不能直接当成一句话

文本天然是一维 token 序列，图像却是二维像素网格。要让 Transformer 处理图像，最常见做法是先把图片切成小块，每个小块叫一个 patch。每个 patch 会被展开并映射成一个向量，相当于“视觉 token”。

```text
原始图片H × W × 3 → 切成 Patch例如 16 × 16 → Patch Embedding视觉 token → 位置编码 → 图像 token 序列
```

> **图示：图片切成 patch 并映射成 embedding 的动画**
>
> 左侧图片网格中的 patch 被依次抽出，经过线性投影变成右侧的 embedding 条形，最后组成视觉 token 序列。

### 21.2 Patch Embedding：把局部图像块变成向量

一个 patch 里有颜色、边缘、纹理和局部形状。Patch embedding 做的事情类似文本 embedding：把离散或局部的原始输入变成一串可计算的小数。不同的是，文本 token 来自词表，图像 patch 来自像素块。

| 文本 Transformer | ViT 图像 Encoder | 共同点 |
| --- | --- | --- |
| 一句话切成 token | 一张图切成 patch | 都先拆成一组基本单位 |
| Token ID 查 embedding | Patch 投影成 embedding | 都变成向量序列 |
| 加位置编码 | 加二维位置对应的位置编码 | 都需要顺序 / 空间位置信息 |
| Self-Attention 建模上下文 | Self-Attention 建模区域关系 | 都让不同位置交换信息 |

### 21.3 Self-Attention：让图像区域互相看见

图片里的语义通常不是单个 patch 决定的。一个 patch 可能只是猫耳朵，另一个 patch 是眼睛，多个区域组合起来才形成“猫”。Self-Attention 让每个视觉 token 和其他视觉 token 交互，从局部纹理逐渐形成全局对象和场景理解。

```text
Patch 1耳朵Patch 2眼睛Patch 3背景 → Self-Attention区域关系 → 全局图像表示一只猫在沙发上
```

### 21.4 聚合成 image embedding

经过多层 Transformer 后，图像 Encoder 会把整张图压缩成一个 image embedding。这个向量不会保存每个像素的全部细节，它更像“这张图的语义摘要”：主要物体、场景、风格和一些显著属性。

<a id="clip-text-encoder"></a>

## 22. 文本 Encoder 如何工作

CLIP 的文本 Encoder 也使用 Transformer 思路，但它的目标和聊天模型不同。聊天模型通常要预测下一个 token；CLIP 文本 Encoder 要把整段描述压缩成一个可与图像向量比较的 text embedding。

```text
Prompt → Tokenizer → Token Embedding + Position → Transformer Encoder → Text Embedding
```

例如 `a photo of a red apple on a table` 会被编码成一个文本向量。这个向量不是词表概率，也不是一句自然语言解释，而是一个语义坐标，方便和图像向量做相似度比较。

> **不要混淆：**文本生成模型的出口是 logits / token 概率；CLIP 文本 Encoder 的出口是一个整体语义向量。

<a id="clip-training"></a>

## 23. 图文对比学习：CLIP 是怎么训练出来的

CLIP 的训练可以用一个 batch 来理解。假设一个 batch 里有 3 张图片和 3 条对应描述，模型会计算每张图和每段文本之间的相似度。

```
正确配对：
image_1 ↔ text_1
image_2 ↔ text_2
image_3 ↔ text_3
```

> **图示：CLIP 相似度矩阵动画**
>
> 三张图片和三段文本形成九个相似度，正确配对位于矩阵对角线并被高亮。

| 相似度 | text_1 | text_2 | text_3 |
| --- | --- | --- | --- |
| image_1 | 高 | 低 | 低 |
| image_2 | 低 | 高 | 低 |
| image_3 | 低 | 低 | 高 |

训练目标是让对角线上的正确图文相似度变高，让非对角线的不匹配组合相似度变低。这样训练很多轮之后，模型就学会了把“语义相同但模态不同”的内容放到相近位置。

```text
CLIP 训练目标 = 匹配图文靠近 + 不匹配图文远离
```

<a id="clip-learns"></a>

## 24. CLIP 学到的到底是什么

CLIP 学到的是跨模态语义对齐，而不是一个完整的视觉世界模型。它很擅长把图片和文本描述做整体匹配，也能通过文本 prompt 做零样本分类；但它不等于检测器、分割器或图像生成器。

| 能力 | CLIP 能做什么 | 边界 |
| --- | --- | --- |
| 图文匹配 | 判断图片和文字是否语义接近 | 细粒度空间关系和计数可能不稳定 |
| 零样本分类 | 把类别写成文本 prompt，与图片比较相似度 | 结果受 prompt 写法影响 |
| 图像理解 | 提取对象、场景、风格等高级语义 | 不直接输出像素级分割 |
| 图像生成 | 提供可比较或可条件化的语义向量 | 本身不负责从噪声生成图片 |

这也是为什么 CLIP 是多模态的起点：它先解决“文字和图像如何进入同一个语义坐标系”，后面的文生图模型才有条件知道 prompt 在要求什么。

<a id="clip-to-diffusion"></a>

## 25. CLIP 如何连接到文生图扩散模型

有了 CLIP 的文本 Encoder，我们就可以把 prompt 编成 text embedding。接下来生成模型不必直接理解原始字符串，而是在去噪过程中反复读取这个文本条件。

```text
Prompt → CLIP Text Encoder → Text Embedding↓随机噪声 / Latent → 去噪网络 → 图像
```

从这里开始，CLIP 的角色更像“语义条件提供者”。它把 prompt 变成模型可读的向量，而真正负责从噪声生成图像的是扩散模型中的去噪网络。

<a id="diffusion"></a>

## 26. 扩散模型：模型每一步到底在学什么

扩散模型不是在“凭空想象图片”，而是在学习一个更具体的问题：**给定一个被噪声污染的样本 `x_t`、当前噪声强度 `t`，以及可选的文本条件 `c`，模型要判断这里面哪一部分更像随机噪声，应该沿哪个方向把它去掉**。训练时答案是已知的，因为噪声就是我们亲手加进去的；生成时答案未知，所以模型要凭训练学到的规律一步步估计 [[9]](#ref9)。

### 26.1 前向加噪：训练样本如何变成带噪样本

先从一张真实图片或 latent 记作 `x0` 开始。训练程序随机抽一个时间步 `t`，再随机抽一份标准高斯噪声 `epsilon`。然后按照噪声日程把干净样本和噪声混合，得到 `x_t`：

```
x_t = sqrt(alpha_bar_t) * x0 + sqrt(1 - alpha_bar_t) * epsilon
epsilon ~ N(0, I)
```

| 符号 | 含义 | 给 0 基础读者的解释 |
| --- | --- | --- |
| `x0` | 干净图像或干净 latent | 训练集中真实存在的目标样本。 |
| `t` | 时间步 / 噪声级别 | `t` 越大，噪声越重；`t` 越小，样本越接近干净图。 |
| `epsilon` | 随机采样出来的噪声 | 这是训练时的标准答案：模型稍后要把它预测出来。 |
| `alpha_bar_t` | 保留原图信号的比例 | 决定 `x_t` 里还剩多少原图，掺了多少噪声。 |
| `x_t` | 第 `t` 步的带噪样本 | 模型真正看到的输入，不是干净图。 |

这一步叫“前向扩散”或“前向加噪”。它不是模型在学，而是训练程序按固定公式制造题目：把一张干净图变成一道带噪题，并保留正确答案 `epsilon`。

> **图示：扩散模型训练样本构造动画**
>
> 干净样本、随机时间步和随机噪声被混合成带噪样本，U-Net 预测噪声并和真实噪声计算损失。

### 26.2 U-Net 的输入和输出分别是什么

训练时，一条样本可以写成：

```
model input  = (x_t, t, text_embedding)   # 带噪 latent、噪声级别、文本条件
model output = epsilon_pred               # 模型预测的噪声
training target = epsilon                 # 刚才真实加进去的噪声
loss = MSE(epsilon_pred, epsilon)
```

这里最容易误解的是：模型通常不是直接输出最终图片，也不是直接输出“下一步更清晰的图”。经典 DDPM 训练目标里，模型输出的是噪声估计 `epsilon_pred`。如果它能在任何 `t` 上准确判断 `x_t` 中的噪声成分，就能把噪声从样本里逐步剥离。

> **关键点：**训练时模型知道答案，因为 `epsilon` 是训练程序自己采样并加进去的。推理生成时模型不知道答案，只能用训练好的网络去估计 `epsilon_pred`。

### 26.3 每个时间步到底在学什么

`t` 不是普通的序号，而是在告诉模型“当前题目的噪声强度”。同一张图在不同 `t` 下会变成不同难度的题目，所以模型要学的不是一个固定去噪动作，而是一个随噪声级别变化的函数：

```text
epsilon_pred = U-Net(x_t, t, c)
```

| 时间步范围 | `x_t` 看起来像什么 | 模型主要学什么 |
| --- | --- | --- |
| `t` 较小 | 大体清晰，只是有轻微颗粒和细节噪声 | 识别边缘、纹理、颜色里的细小噪声，避免把真实细节误删。 |
| `t` 中等 | 主体结构还在，但局部已经模糊 | 判断哪些结构符合真实图像统计，哪些扰动应该被削弱。 |
| `t` 较大 | 几乎是随机噪声，只剩很弱的语义线索 | 在文本条件和数据分布约束下，估计“往哪边走更可能出现合理图像”的大方向。 |

所以“每一步学习去噪”更准确地说是：模型学习在不同噪声强度下，**从当前带噪样本中估计噪声成分的条件分布**。它不是记住某一张噪声图，而是学会：当输入长成这种样子、噪声强度是这个级别、文本条件要求这种语义时，哪些变化更像随机噪声，哪些变化更像真实图像的一部分。

### 26.4 为什么说它学的是噪声分布

单看一张 `x_t`，我们无法肉眼确定每个像素或 latent 位置里到底混了多少噪声。但训练数据里有大量例子：不同图片、不同 `t`、不同随机 `epsilon`。模型反复看到这些题目后，学到的是一个统计规律：

```
给定 (x_t, t, c)，哪些 epsilon 更可能是当初加进去的噪声？
```

在概率视角下，它近似学习的是“从噪声分布走回数据分布”的方向。更专业地说，去噪模型和 score-based view 有联系：模型学到的方向与 `∇ log p_t(x_t | c)` 有关，也就是让当前样本往更高概率、更像真实训练图像的位置移动的方向。对初学者可以先记成：**它不是在背图，而是在学一个方向场：当前位置该往哪里改，才更不像随机噪声、更像符合文本条件的真实图像**。

> **“分布”是什么意思：**不是一张标准答案图，而是一片可能性区域。比如 prompt 要求“红苹果”，合理图像可以有很多张；模型学习的是这些合理图像在 latent 空间中大致聚在哪里，以及从噪声点怎么一步步走向这些区域。

### 26.5 推理生成时，每一步如何更新 latent

生成时没有真实 `x0`，也没有真实 `epsilon`。流程反过来：先从随机 latent `x_T` 开始，把当前 `x_t`、时间步 `t` 和文本条件 `c` 交给 U-Net，得到 `epsilon_pred`。然后 scheduler 用这个预测噪声计算下一步更干净的 `x_{t-1}`。

```text
当前 latentx_t + 时间步t + 文本条件c → U-Net → 预测噪声epsilon_pred → Scheduler 更新x_{t-1}
```

可以把 scheduler 理解成“按公式走一步的人”。U-Net 负责告诉它当前噪声大概是什么；scheduler 负责根据噪声日程、步长和采样方法，把 `x_t` 改成更接近干净样本的 `x_{t-1}`。不同 scheduler 的公式不同，所以同一个模型换 scheduler，速度、稳定性和画面细节可能会变。

> **图示：扩散模型多步去噪动画**
>
> 左侧噪声 latent 输入 U-Net，U-Net 预测噪声，scheduler 根据预测噪声更新 latent，重复后得到清晰图像。

### 26.6 训练和生成的区别

| 阶段 | 有没有真实图片 `x0` | 有没有真实噪声 `epsilon` | 模型做什么 |
| --- | --- | --- | --- |
| 训练 | 有，来自训练集 | 有，由训练程序采样并记录 | 根据 `x_t`、`t`、`c` 预测 `epsilon`，用损失函数修正参数。 |
| 生成 | 没有 | 没有 | 从随机 `x_T` 出发，反复预测 `epsilon_pred` 并更新 latent。 |

U-Net 是图像生成里常见的去噪网络结构，它既能保留空间分辨率，又能在不同尺度上处理局部纹理和全局结构 [[10]](#ref10)。Stable Diffusion 这类模型通常不直接在像素空间去噪，而是在更小的 latent 空间去噪，再用 VAE decoder 解码成图片；这就是 Latent Diffusion 的核心思路 [[11]](#ref11)。

> **到这里的心智模型：**扩散模型训练时反复制造“带噪样本 - 真实噪声答案”的题目；U-Net 学会根据 `x_t`、`t` 和文本条件估计噪声；生成时 scheduler 使用这些噪声估计，把随机 latent 一步步推向高概率的清晰图像区域。

<a id="cross-attention"></a>

## 27. Cross-Attention：文本条件如何控制去噪

前面讲 Self-Attention 时，每个 token 的 Q、K、V 都来自同一段序列。Cross-Attention 的区别是：Query 来自当前图像 latent，Key 和 Value 来自文本 embedding。这样图像在每一步去噪时，都可以“查看” prompt 里哪些词最相关。

| 机制 | Q 来自哪里 | K/V 来自哪里 | 作用 |
| --- | --- | --- | --- |
| Self-Attention | 同一批文本 token | 同一批文本 token | 文本内部交换上下文 |
| 图像 Self-Attention | 图像 latent patch / feature | 图像 latent patch / feature | 图像区域之间交换信息 |
| Cross-Attention | 图像 latent | 文本 embedding | 让图像生成过程受 prompt 控制 |

> **图示：Cross-Attention 控制去噪动画**
>
> 图像 latent 作为 query，连接到文本词向量 key value，读取红苹果和木桌等条件后更新 latent。

```text
当前 LatentQuery → Cross-Attention ← Text EmbeddingKey / Value → 带文本条件的去噪结果
```

例如 prompt 是 `a red apple on a wooden table`，去噪网络在生成物体区域时会从文本条件中读取“red apple”，在生成背景和接触面时会读取“wooden table”。这不是人工规则，而是训练中通过图文数据和去噪损失学出来的条件控制。

<a id="stable-diffusion-flow"></a>

## 28. Stable Diffusion 的完整数据流

把 CLIP 和扩散模型合起来，就得到文生图模型的主流程。这里用 Stable Diffusion 风格的数据流做一个简化版总结。

```text
Prompt → Tokenizer → CLIP Text Encoder → Text EmbeddingRandom Latent → U-Net 去噪 × N → Clean Latent → VAE Decoder → Image
```

1. Prompt 先被 tokenizer 切成 token。
2. CLIP Text Encoder 把 token 序列编码成 text embedding。
3. 模型从随机 latent 开始，而不是从空白画布开始。
4. U-Net 在多个时间步里预测噪声，并通过 cross-attention 读取文本条件。
5. Scheduler 根据预测噪声更新 latent。
6. 最后 VAE Decoder 把 latent 解码成可见图片。

> **一条主线：**Transformer 解决文本序列中的信息流动；CLIP 解决文字和图像的语义对齐；扩散模型解决如何在文本条件下从噪声生成图像。

<a id="lora"></a>

## 29. LoRA：给大模型加一个很小的可训练旁路

到这里，我们已经知道文生图模型的主干很大：CLIP Text Encoder 负责理解 prompt，U-Net 负责在每一步预测噪声，VAE 负责 latent 和图像之间的转换。如果想让模型学会一个新人物、一种画风、一个产品外观，最直接的方法是微调整个模型。但这样代价很高，也容易破坏原模型已有能力。

LoRA，Low-Rank Adaptation，解决的是这个问题：**冻结原来的大模型权重，只在少数线性层旁边训练一个很小的低秩增量**。推理时，这个增量像一个可插拔补丁，轻轻改变模型内部的信息流，从而影响最终生成结果 [[12]](#ref12)。

### 29.1 先理解普通线性层：输入向量乘以权重矩阵

神经网络里大量计算都可以简化成一件事：输入向量 `x` 乘以权重矩阵 `W`，得到输出向量 `y`。

```
y = W x
```

`W` 可以理解成模型已经学到的“转换规则”。在 Attention 里，生成 `Q`、`K`、`V` 的投影层就是这样的线性变换；在 U-Net 里，许多卷积层和线性层也承担类似的信息变换职责。

### 29.2 LoRA 不直接改 W，而是学习一个小增量

完整微调会直接更新大矩阵 `W`。LoRA 的做法是冻结 `W`，额外学习一个增量 `Delta W`：

```
原始输出：y = W x
LoRA 后：y = W x + Delta W x
```

关键在于，LoRA 不把 `Delta W` 也做成一个完整大矩阵，而是把它拆成两个很瘦的小矩阵：

```
Delta W = B A
A: r × input_dim
B: output_dim × r
r 很小，比如 4、8、16、32
```

这就是“低秩”的意思：不让增量拥有完整矩阵那么大的自由度，只允许它通过一个很窄的中间通道表达变化。

> **图示：LoRA 低秩旁路动画**
>
> 输入向量一条路径经过冻结的原始权重矩阵，另一条路径经过两个小矩阵 A 和 B，最后相加得到带 LoRA 的输出。

### 29.3 LoRA 影响 Stable Diffusion 的哪部分

在文生图里，LoRA 最常见的作用位置是 U-Net 里的 attention 投影层，尤其是 cross-attention 相关的 `to_q`、`to_k`、`to_v`、`to_out` 等线性层；也可以作用在部分卷积层，或者同时给文本 Encoder 加 LoRA。不同训练脚本和模型结构会有差异，但核心都是：**让少量可训练增量改变去噪网络如何读取文本、如何组织图像特征、如何预测噪声**。

| 位置 | LoRA 改变什么 | 对生图结果的影响 |
| --- | --- | --- |
| U-Net Cross-Attention | 图像 latent 如何读取文本 token | 触发词更容易指向特定人物、服饰、风格或物体。 |
| U-Net Self-Attention / 线性层 | 图像区域之间如何交换特征 | 影响构图、局部结构、材质和风格一致性。 |
| 部分卷积层 | 局部纹理和空间特征加工方式 | 更直接影响线条、质感、脸部细节、服装纹理等。 |
| Text Encoder LoRA | 文本 token 的语义表示 | 改变触发词或描述词进入 U-Net 前的语义坐标。 |

所以 LoRA 不是“贴一张参考图到模型旁边”，而是在模型内部少数关键转换处加入可学习的方向修正。它影响的是去噪过程中的中间特征和条件读取方式，最终表现为生成图像的概念、风格或角色发生偏移。

### 29.4 为什么 LoRA 可以四两拨千斤

大模型已经学会了大量通用能力：什么是脸、衣服、光照、透视、线条、材质，以及 prompt 如何控制图像。训练一个角色 LoRA 或风格 LoRA 时，我们通常不需要从零学习“如何画人”或“如何画图片”，只需要让模型在原有能力上增加一个小方向：看到某个触发词时，更倾向于生成某个特定概念。

> **四两拨千斤的原因：**LoRA 借用底模已经学好的庞大视觉世界，只训练少量参数去改变关键层的输出方向。它不是重新造一台机器，而是在已有机器的几个控制旋钮上加微调。

低秩限制也有好处：参数少、文件小、训练快，且不容易像全量微调那样把底模广泛改坏。但它也意味着 LoRA 更适合学习相对集中的概念、风格或角色；如果要让模型获得大范围新能力，单个小 LoRA 可能不够。

### 29.5 生图 LoRA 的训练：把触发词和图像概念绑定起来

在生图领域，很多 LoRA 训练的核心目标可以这样理解：**让模型学会当 prompt 中出现某个触发词时，就把它和训练图片里的某个视觉概念联系起来**。这个概念可以是一个人物、一种画风、一件衣服、一个产品、一个姿势组合，或者一类特殊材质。

```text
训练图片某角色 / 风格 / 物体 + Captionsks person, red dress → 加噪 latent → 冻结底模 + LoRA → 预测噪声 → 只更新 LoRA
```

训练过程仍然沿用扩散模型的去噪任务：图片先被 VAE 编成 latent，再随机加噪得到 `x_t`；caption 经过文本 Encoder 变成条件；U-Net 预测噪声；损失函数比较 `epsilon_pred` 和真实噪声 `epsilon`。区别是：底模参数冻结，反向传播只更新 LoRA 的小矩阵。

```
训练图片 + caption: "sks person, white coat"
      ↓
VAE 编码成 latent x0
      ↓
加噪得到 x_t，并记录真实噪声 epsilon
      ↓
U-Net(x_t, t, text_embedding) 输出 epsilon_pred
      ↓
loss = MSE(epsilon_pred, epsilon)
      ↓
只更新 LoRA 的 A、B 矩阵
```

为什么这会把触发词和图像概念对应起来？因为每张训练图的 caption 都反复把触发词和同一类视觉特征放在一起。模型在去噪时发现：当文本条件里有 `sks person`，要想把噪声预测对，就需要在相关层里激活某些脸型、发型、服饰、画风或产品形态的方向。多轮训练后，LoRA 的小矩阵就学成了一个条件化的概念补丁。

| 训练要素 | 实际作用 | 常见问题 |
| --- | --- | --- |
| 触发词 | 给新概念一个文本入口 | 太常见的词容易和原有语义混淆，通常会用较独特的 token 组合。 |
| Caption | 告诉模型哪些是概念本体，哪些是可变化属性 | caption 太少会把背景、姿势、衣服也错误绑定进触发词。 |
| 训练图片 | 提供概念的视觉分布 | 图片太单一会过拟合，只会复现相似构图。 |
| LoRA rank / 权重 | 控制可学习增量容量和推理影响强度 | 容量太小学不住，太大或权重太高容易污染底模输出。 |

### 29.6 触发词不是魔法开关，而是条件入口

触发词能生效，不是因为模型“记住了这个词的中文含义”，而是训练把这个 token 的文本 embedding 和一组视觉去噪方向绑定了起来。推理时，当 prompt 里出现触发词，cross-attention 会把这个 token 的条件信息送进 U-Net；LoRA 又改变了相关层的权重增量，于是去噪方向被拉向训练图里的概念。

> **需要区分：**Textual Inversion 主要学习新的文本 embedding；LoRA 主要学习模型层里的权重增量。二者都可以服务触发词，但一个偏“新词向量”，一个偏“改变模型如何响应这个词”。

<a id="mistakes"></a>

## 30. 初学者常见误区

### 误区 1：Attention 就是人类注意力

不是。它不是模型“有意识地注意”。它是一个数学加权机制：计算 token 之间的相关性，再按权重汇总信息。

### 误区 2：Token 就是词

不一定。Token 可能是字、词、子词，图像里的 patch 也可以被看作视觉 token。

### 误区 3：Embedding 是人工写好的字典解释

不是。Embedding 是训练出来的向量表或投影结果，不是人工给每个词、每个图像块写说明。

### 误区 4：CLIP 会生成图片

CLIP 的核心能力是图文对齐。它能把文本和图片编码到同一个语义空间，但不负责从噪声生成像素。

### 误区 5：扩散模型一步画完整张图

扩散模型通常是多步迭代生成。每一步都在当前噪声状态上做一次小修正，逐渐得到清晰图像。

### 误区 6：文本条件只是贴在模型旁边的标签

不是。在文生图扩散模型里，文本 embedding 会通过 cross-attention 进入去噪网络，影响每一步 latent 如何更新。

### 误区 7：LoRA 是一整套新模型

不是。LoRA 通常只是附加在底模关键层上的小型权重增量。没有底模，LoRA 本身不能独立完成文生图。

### 误区 8：触发词本身包含图像概念

不是。触发词只是入口。真正学到的是“这个 token 出现时，去噪网络应该往某个视觉概念方向修正”的能力。

<a id="summary"></a>

## 31. 你可以记住的最小心智模型

1. 神经网络通过“预测 → 损失 → 反向传播 → 更新参数”训练。
2. 语言是序列问题，顺序和上下文很重要。
3. Attention 让任意位置直接查看其他位置，减少信息长链传递的压力。
4. Transformer 把文本变成向量，用多层 attention 和 FFN 加工上下文，最后输出下一个 token 的概率。
5. CLIP 用文本 Encoder 和图像 Encoder，把文字和图片放进同一个语义空间。
6. ViT 式图像 Encoder 把图片切成 patch，把 patch 当成视觉 token，再用 attention 建模区域关系。
7. 扩散模型从随机噪声开始，多步预测并去掉噪声。
8. 文生图模型用 CLIP 文本向量作为条件，通过 cross-attention 控制每一步去噪。
9. LoRA 冻结底模，只训练小的低秩权重增量，让模型学会对某个触发词或风格做定向响应。

```text
训练循环 → Transformer → 文本生成 → CLIP 图文对齐 → 扩散去噪 → 文生图 → LoRA 轻量适配
```

如果始终沿着数据流看，Transformer、CLIP、扩散模型和 LoRA 不是孤立知识：它们分别解决序列建模、跨模态对齐、条件生成和轻量定制四个连续问题。

<a id="references"></a>

## References

1. <a id="ref1"></a>Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Lukasz Kaiser, Illia Polosukhin. *Attention Is All You Need*. arXiv:1706.03762, 2017. [https://arxiv.org/abs/1706.03762](https://arxiv.org/abs/1706.03762)
2. <a id="ref2"></a>Jay Alammar. *The Illustrated Transformer*. 2018. [https://jalammar.github.io/illustrated-transformer/](https://jalammar.github.io/illustrated-transformer/)
3. <a id="ref3"></a>David E. Rumelhart, Geoffrey E. Hinton, Ronald J. Williams. *Learning representations by back-propagating errors*. Nature, 1986.
4. <a id="ref4"></a>Sepp Hochreiter, Jürgen Schmidhuber. *Long Short-Term Memory*. Neural Computation, 1997.
5. <a id="ref5"></a>Dzmitry Bahdanau, Kyunghyun Cho, Yoshua Bengio. *Neural Machine Translation by Jointly Learning to Align and Translate*. arXiv:1409.0473, 2014 / ICLR 2015. [https://arxiv.org/abs/1409.0473](https://arxiv.org/abs/1409.0473)
6. <a id="ref6"></a>Jianlin Su, Yu Lu, Shengfeng Pan, Ahmed Murtadha, Bo Wen, Yunfeng Liu. *RoFormer: Enhanced Transformer with Rotary Position Embedding*. arXiv:2104.09864, 2021. [https://arxiv.org/abs/2104.09864](https://arxiv.org/abs/2104.09864)
7. <a id="ref7"></a>Alec Radford, Jong Wook Kim, Chris Hallacy, Aditya Ramesh, Gabriel Goh, Sandhini Agarwal, Girish Sastry, Amanda Askell, Pamela Mishkin, Jack Clark, Gretchen Krueger, Ilya Sutskever. *Learning Transferable Visual Models From Natural Language Supervision*. arXiv:2103.00020, 2021. [https://arxiv.org/abs/2103.00020](https://arxiv.org/abs/2103.00020)
8. <a id="ref8"></a>Alexey Dosovitskiy, Lucas Beyer, Alexander Kolesnikov, Dirk Weissenborn, Xiaohua Zhai, Thomas Unterthiner, Mostafa Dehghani, Matthias Minderer, Georg Heigold, Sylvain Gelly, Jakob Uszkoreit, Neil Houlsby. *An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale*. arXiv:2010.11929, 2020. [https://arxiv.org/abs/2010.11929](https://arxiv.org/abs/2010.11929)
9. <a id="ref9"></a>Jonathan Ho, Ajay Jain, Pieter Abbeel. *Denoising Diffusion Probabilistic Models*. arXiv:2006.11239, 2020. [https://arxiv.org/abs/2006.11239](https://arxiv.org/abs/2006.11239)
10. <a id="ref10"></a>Olaf Ronneberger, Philipp Fischer, Thomas Brox. *U-Net: Convolutional Networks for Biomedical Image Segmentation*. arXiv:1505.04597, 2015. [https://arxiv.org/abs/1505.04597](https://arxiv.org/abs/1505.04597)
11. <a id="ref11"></a>Robin Rombach, Andreas Blattmann, Dominik Lorenz, Patrick Esser, Bjorn Ommer. *High-Resolution Image Synthesis with Latent Diffusion Models*. arXiv:2112.10752, 2021. [https://arxiv.org/abs/2112.10752](https://arxiv.org/abs/2112.10752)
12. <a id="ref12"></a>Edward J. Hu, Yelong Shen, Phillip Wallis, Zeyuan Allen-Zhu, Yuanzhi Li, Shean Wang, Lu Wang, Weizhu Chen. *LoRA: Low-Rank Adaptation of Large Language Models*. arXiv:2106.09685, 2021. [https://arxiv.org/abs/2106.09685](https://arxiv.org/abs/2106.09685)
