# Feedback

The following are folders organized by the (agent-provider) 
- then organized into main top-level-sub-systems represented as nested folders. 
- use the [config.yml](.feedback/config.yml) for the authoritative list of the TLCs
- within each of those subfolders make a "pile of files". 
- Where each file represents an issue to investigate / something to consider fixing.

### PreProcessing
First, if there are files in `~raw-input` /  `<name>.txt` then please read it, 
and break it down into file-issues using this naming template:

  `{Issue Nuumnber} -P{num}- {Issue-Name-with-dashes}.md`

## Main Process
Then the task/process for each file is:

- Create a proposal for how to fix it, and write the proposal in a `<total issue name >.fix.md` file
  - Perform Web research if deemed useful
- Usually a human or different agent will cross reference your proposals.
- it is highly recommended to leave implementation `detail-bread-crumbs` for yourself in that file before you move on, 
- FYI - sometimes you will be called back to implement your own proposals, other times it will be a different agent.
- When an implementation is commited to git, move back to the issue file, and simply mark the `... .fix.md` + the `... .md` files with a ✅ somewhere in the title (usually the first char) and then run:
  
## Clean Up Process
A reinde file will 
```bash
node .feedback/reindex.mjs 
```
