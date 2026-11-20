import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockClient } from "../../api/mock";
import { ListView } from "./List";
import { ReceiptsView } from "./Receipts";
import { WatchView } from "./Watch";

const NOW = 1_763_500_000_000;
const flush = () => new Promise((r) => setTimeout(r, 30));
// eslint-disable-next-line no-control-regex -- stripping ANSI escapes
const plain = (s = "") => s.replace(/\u001b\[[0-9;]*m/g, "");

beforeEach(() => {
  vi.stubEnv("NO_COLOR", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bounty list", () => {
  it("renders a table that fits in 80 columns", async () => {
    const client = new MockClient({ now: () => NOW, manual: true });
    const { lastFrame, unmount } = render(<ListView client={client} width={80} now={NOW} />);
    await flush();
    const frame = plain(lastFrame());
    expect(frame).toContain("3 open · 700.00 USDC available · source mock");
    expect(frame).toMatch(/b-101\s+Token-bucket rate limiter.*250\.00 USDC\s+in 2d 5h\s+3\s+open/);
    expect(frame).toMatch(/b-102 .* awarded/);
    expect(frame).toMatch(/b-105 .* refunded/);
    for (const line of frame.split("\n")) expect(Array.from(line).length).toBeLessThanOrEqual(80);
    unmount();
  });

  it("shows API errors", async () => {
    const client = new MockClient({ manual: true });
    client.listBounties = async () => {
      throw new Error("No API at http://localhost:4000");
    };
    const { lastFrame, unmount } = render(<ListView client={client} width={80} />);
    await flush();
    expect(plain(lastFrame())).toContain("✗ No API at http://localhost:4000");
    unmount();
  });
});

describe("bounty watch", () => {
  it("shows live progress through the workflow until payout", async () => {
    const client = new MockClient({ now: () => NOW, manual: true });
    const { lastFrame, unmount } = render(<WatchView client={client} bountyId="b-101" width={80} now={NOW} />);
    await flush();

    let frame = plain(lastFrame());
    expect(frame).toContain("b-101  Token-bucket rate limiter middleware for Express");
    expect(frame).toMatch(/s-101a\s+fast-careless\s+[0-9a-f]{7}\s+building/);
    expect(frame).toMatch(/✓ Submitted ─ ✓ Build ─ \S Tests ─ · Security ─ · Accepted ─ · Paid/);
    expect(frame).toContain("3 running · 0 awaiting creator · 0 rejected · 0 paid");
    expect(frame).toContain("Watching live");

    for (let i = 0; i < 5; i++) client.tick();
    await flush();
    frame = plain(lastFrame());
    expect(frame).toContain("rejected at tests: 4 of 18 tests failed");
    expect(frame).toContain("✓ Submitted ─ ✓ Build ─ ✗ Tests ─ · Security");
    expect(frame).toMatch(/Tests failed · receipt 0x[0-9a-f]{6}…[0-9a-f]{4}/);

    for (let i = 0; i < 6; i++) client.tick();
    await flush();
    frame = plain(lastFrame());
    expect(frame).toMatch(/✓ s-101b\s+test-focused\s+[0-9a-f]{7}\s+paid/);
    expect(frame).toContain("✓ Submitted ─ ✓ Build ─ ✓ Tests ─ ✓ Security ─ ✓ Accepted ─ ✓ Paid");
    expect(frame).toMatch(/✓ Paid 250\.00 USDC to s-101b · tx 0x[0-9a-f]{10}…[0-9a-f]{8}/);
    expect(frame).toContain("0 running · 0 awaiting creator · 1 rejected · 1 paid");
    expect(frame).not.toContain("Watching live");
    for (const line of frame.split("\n")) expect(Array.from(line).length).toBeLessThanOrEqual(80);
    unmount();
  });

  it("uses a compact progress line on narrow terminals", async () => {
    const client = new MockClient({ now: () => NOW, manual: true });
    const { lastFrame, unmount } = render(<WatchView client={client} bountyId="b-103" width={60} now={NOW} />);
    await flush();
    const frame = plain(lastFrame());
    expect(frame).toContain("✓ ✓ ✓ ✓ ◷ ·");
    expect(frame).toContain("✓ ✗ · · · ·");
    unmount();
  });
});

describe("bounty receipts", () => {
  it("checks every receipt against the submission commit", async () => {
    const client = new MockClient({ now: () => NOW, manual: true });
    const { lastFrame, unmount } = render(<ReceiptsView client={client} submissionId="s-102b" width={80} />);
    await flush();
    const frame = plain(lastFrame());
    expect(frame).toMatch(/Acceptance\s+✓ pass/);
    expect(frame).toMatch(/✓ All 4 receipts bound to commit [0-9a-f]{7}/);
    expect(frame).toContain("✓ Payout tx");
    unmount();
  });
});
