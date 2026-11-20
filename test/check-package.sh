#!/bin/sh
set -eu

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
npm pack --pack-destination "$work" --json > "$work/pack.json"
node -e '
  const assert = require("node:assert/strict");
  const [pkg] = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const files = pkg.files.map((file) => file.path);
  for (const required of ["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE"]) {
    assert.ok(files.includes(required), "missing from package: " + required);
  }
  const unexpected = files.filter((file) => !/^(dist\/|README\.md$|llms\.txt$|LICENSE$|CHANGELOG\.md$|package\.json$)/.test(file));
  assert.deepEqual(unexpected, []);
' "$work/pack.json"

cd "$work"
npm install --offline --ignore-scripts --no-audit --no-fund --no-save ./enigmoss-*.tgz
node --input-type=module -e 'import assert from "node:assert/strict"; import { Enigmoss } from "enigmoss"; assert.equal(typeof Enigmoss, "function");'
