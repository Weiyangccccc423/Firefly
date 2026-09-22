import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

type DefaultString = z.ZodDefault<z.ZodOptional<z.ZodString>>;
type DefaultBoolean = z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;

const postSchema: z.ZodObject<{
	title: z.ZodString;
	published: z.ZodDate;
	updated: z.ZodOptional<z.ZodDate>;
	draft: DefaultBoolean;
	description: DefaultString;
	image: DefaultString;
	tags: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
	category: z.ZodDefault<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
	lang: DefaultString;
	pinned: DefaultBoolean;
	author: DefaultString;
	sourceLink: DefaultString;
	licenseName: DefaultString;
	licenseUrl: DefaultString;
	comment: DefaultBoolean;
	password: DefaultString;
	passwordHint: DefaultString;
	prevTitle: z.ZodDefault<z.ZodString>;
	prevSlug: z.ZodDefault<z.ZodString>;
	nextTitle: z.ZodDefault<z.ZodString>;
	nextSlug: z.ZodDefault<z.ZodString>;
}> = z.object({
	title: z.string(),
	published: z.date(),
	updated: z.date().optional(),
	draft: z.boolean().optional().default(false),
	description: z.string().optional().default(""),
	image: z.string().optional().default(""),
	tags: z.array(z.string()).optional().default([]),
	category: z.string().optional().nullable().default(""),
	lang: z.string().optional().default(""),
	pinned: z.boolean().optional().default(false),
	author: z.string().optional().default(""),
	sourceLink: z.string().optional().default(""),
	licenseName: z.string().optional().default(""),
	licenseUrl: z.string().optional().default(""),
	comment: z.boolean().optional().default(true),
	password: z.string().optional().default(""),
	passwordHint: z.string().optional().default(""),
	/* For internal use */
	prevTitle: z.string().default(""),
	prevSlug: z.string().default(""),
	nextTitle: z.string().default(""),
	nextSlug: z.string().default(""),
});

const postsCollection: ReturnType<
	typeof defineCollection<typeof postSchema, ReturnType<typeof glob>>
> = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/posts" }),
	schema: postSchema,
});

const specCollection: ReturnType<
	typeof defineCollection<
		z.ZodObject<Record<string, never>>,
		ReturnType<typeof glob>
	>
> = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/spec" }),
	schema: z.object({}),
});

const dynamicCollection: ReturnType<
	typeof defineCollection<
		z.ZodObject<{ published: z.ZodDate }>,
		ReturnType<typeof glob>
	>
> = defineCollection({
	loader: glob({ pattern: "**/*.md", base: "./src/content/dynamic" }),
	schema: z.object({
		published: z.date(),
	}),
});

export const collections: {
	dynamic: typeof dynamicCollection;
	posts: typeof postsCollection;
	spec: typeof specCollection;
} = {
	dynamic: dynamicCollection,
	posts: postsCollection,
	spec: specCollection,
};
