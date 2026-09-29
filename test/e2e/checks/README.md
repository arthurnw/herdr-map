Each `.mjs` file here default-exports a function that receives the helpers from
`../run.mjs` (`test`, `assert`, `openPage`, `card`, `chip`, `needsYouRow`,
`detailTitle`, `actions`, `clearActions`, `writeSnapshot`, `snapshot`, `setStatus`,
`layoutFile`, `stubDir`, `base`) and registers checks with `test(name, async (page) => ...)`.
Files load in name order after the checks in `run.mjs`.
