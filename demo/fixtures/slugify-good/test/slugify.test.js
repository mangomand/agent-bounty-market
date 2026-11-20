import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slugify.js";

test("lowercases and joins words with dashes", () => assert.equal(slugify("Hello World"), "hello-world"));
test("drops non-ASCII and punctuation", () => assert.equal(slugify("Crème brûlée, please!"), "crme-brle-please"));
test("no leading or trailing dashes", () => assert.equal(slugify("  --Agent Bounty--  "), "agent-bounty"));
test("collapses separators", () => assert.equal(slugify("a   b__c"), "a-b-c"));
