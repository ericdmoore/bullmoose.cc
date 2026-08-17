Blogging Agent + Engine
=================

> **Status: raw notes, not started (2026-08-13).** No code — zero hits for `blog@`/`blogging` outside `node_modules`. The requirements below are open questions, not a spec.

# Converational requirements:

- Send in Blog Content
  - Edit by: subect === URL; resend whole content corrected.
  - Reply after/when page is live
- ONLY configured users can send an email to `blog@`
- External and not-configured users are ghosted - perhaps the email never even getst to the blog agent?
- Who configures Contact-book?
  - maybe humans request to get blogging permissions? /approvals via an `admin` ( potentially a new approval escaltion ? )
- Who confgures the blogging theme/template?
- "Open specs" for templating is coming..
- User can choose:
  - a template for their UFP
  - a sub-template page-template-variation - per page - using front matter

# HTTP Surface

## Directory Index

> {domain}/blog

## Users Front Page (UFP)

> {domain}/blog/{username}

## Users Post Page

> {domain}/blog/{username}/{date}/{subject}

Email body might have frontmatter
