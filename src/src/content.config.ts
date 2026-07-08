import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

// Guides are sourced straight from the repo playbooks — one source, two
// surfaces (GitHub + the site). Titles/blurbs live in src/lib/guidesMeta.ts
// (the playbooks stay frontmatter-free so they render cleanly on GitHub).
const guides = defineCollection({
  loader: glob({ pattern: ["*.md", "!README.md"], base: "../docs/playbooks" }),
});

export const collections = { guides };
