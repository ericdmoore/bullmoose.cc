// @ts-check
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import preact from "@astrojs/preact";

// Static output (default) — brochure + guides, no SSR. Deploys as static
// assets to Cloudflare Pages. Design/plan: docs/architecture/marketing-site.md.

// Rewrite the playbooks' repo-relative links for the web: sibling playbooks
// (docs/playbooks/*.md) → in-site /guides/<slug> routes; every other repo
// link → its canonical GitHub blob URL. Keeps the guides one-source with the
// repo without hand-editing their Markdown.
const REPO_BLOB = "https://github.com/ericdmoore/bullmoose.cc/blob/main";
function resolveFromPlaybooks(rel) {
  const parts = ("docs/playbooks/" + rel).split("/");
  const out = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}
function rewritePlaybookLinks() {
  return (tree) => {
    const walk = (node) => {
      if (node.tagName === "a" && node.properties && typeof node.properties.href === "string") {
        const href = node.properties.href;
        if (!/^(https?:|#|mailto:|\/)/.test(href)) {
          const [p, hash] = href.split("#");
          const resolved = resolveFromPlaybooks(p);
          const sibling = resolved.match(/^docs\/playbooks\/([^/]+)\.md$/);
          node.properties.href =
            (sibling ? `/guides/${sibling[1]}` : `${REPO_BLOB}/${resolved}`) + (hash ? `#${hash}` : "");
        }
      }
      if (node.children) node.children.forEach(walk);
    };
    walk(tree);
  };
}

export default defineConfig({
  site: "https://bullmoose.cc",
  // Preact powers the one interactive island — the /deploy agent wizard.
  // Everything else stays static (zero JS).
  integrations: [preact()],
  // Astro 7: customize Markdown via a unified() processor (gfm + Shiki +
  // smartypants stay on by default). Our rehype pass rewrites playbook links.
  markdown: { processor: unified({ rehypePlugins: [rewritePlaybookLinks] }) },
});
