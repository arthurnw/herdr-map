// Lineage edges, from a pane's `parent` token: routed between card sides and around other cards.
export default ({ test, assert, card, writeSnapshot, snapshot, setStatus }) => {
  // In the fixture, w3:p5's parent is w1:p1, two workspaces to its left, with w2's stacked cards in between.
  const EDGE = "edge:w1:p1->w3:p5";
  const OTHERS = ["w2:p3", "w2:p4", "w4:p7", "w5:p9"];
  const edge = (page) => page.locator(`.react-flow__edge[data-id="${EDGE}"]`);

  /** Points along the edge's path, in screen pixels. */
  const pathPoints = (page) =>
    edge(page)
      .locator("path.react-flow__edge-path")
      .evaluate((el) => {
        const m = el.getScreenCTM();
        const len = el.getTotalLength();
        return Array.from({ length: 101 }, (_, i) => {
          const p = el.getPointAtLength((len * i) / 100);
          return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
        });
      });

  const inside = (p, box) => p.x > box.x + 1 && p.x < box.x + box.width - 1 && p.y > box.y + 1 && p.y < box.y + box.height - 1;
  const onBorder = (p, box) =>
    p.x >= box.x - 2 && p.x <= box.x + box.width + 2 && p.y >= box.y - 2 && p.y <= box.y + box.height + 2 && !inside(p, box);
  const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

  test("lineage: an edge whose straight line would cross other cards goes around them", async (page) => {
    await edge(page).waitFor({ state: "attached", timeout: 3000 });
    const from = await card(page, "w1:p1").boundingBox();
    const to = await card(page, "w3:p5").boundingBox();
    const others = await Promise.all(OTHERS.map(async (id) => [id, await card(page, id).boundingBox()]));

    // The fixture has to put a card in the way for this check to mean anything.
    const [a, b] = [center(from), center(to)];
    const straight = Array.from({ length: 101 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / 100, y: a.y + ((b.y - a.y) * i) / 100 }));
    assert(
      others.some(([, box]) => straight.some((p) => inside(p, box))),
      `a straight line between the cards should cross another card: ${JSON.stringify({ from, to, others })}`,
    );

    const points = await pathPoints(page);
    assert(onBorder(points[0], from), `the edge should leave from the parent card's side: ${JSON.stringify({ start: points[0], from })}`);
    assert(onBorder(points.at(-1), to), `the edge should end on the child card's side: ${JSON.stringify({ end: points.at(-1), to })}`);
    for (const [id, box] of [...others, ["w1:p1", from], ["w3:p5", to]]) {
      const hit = points.find((p) => inside(p, box));
      assert(!hit, `the edge should not pass through ${id}: ${JSON.stringify({ hit, box })}`);
    }
  });

  test("lineage: the edge is animated while the child agent works", async (page) => {
    try {
      await edge(page).waitFor({ state: "attached", timeout: 3000 });
      assert(!(await edge(page).getAttribute("class")).includes("animated"), "an idle child's edge should be still");
      writeSnapshot(setStatus(snapshot(), "w3:p5", "working"));
      await page.locator(`.react-flow__edge.animated[data-id="${EDGE}"]`).waitFor({ state: "attached", timeout: 4000 });
    } finally {
      writeSnapshot(snapshot());
    }
  });
};
