const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSearchTree,
  buildDiscographyChildren,
  visibleRows,
  toggleExpanded,
  shouldLoadDiscography,
  isDiscographyLoading,
  mergeDiscography,
  normalizeRelatedReleaseGroups,
} = require("../search-tree");

test("artist search roots are separate from global release and track matches", () => {
  const tree = buildSearchTree({
    artists: [{ type: "artist", title: "Nirvana", ratingKey: "artist-1" }],
    albums: [{ type: "album", title: "Nirvana", artist: "Nirvana", ratingKey: "album-1" }],
    tracks: [{ type: "track", title: "Nirvana", artist: "Tom Waits", ratingKey: "track-1" }],
  });

  assert.deepEqual(tree.map((node) => [node.kind, node.title]), [
    ["artist", "Nirvana"],
    ["other", "Other matching releases/tracks"],
  ]);
  assert.deepEqual(tree[1].children.map((node) => node.title), ["Nirvana", "Nirvana"]);
});

test("direct artist children remain album leaves when Plex provides no release category", () => {
  const children = buildDiscographyChildren([
    { title: "In Utero", year: 1993, ratingKey: "3" },
    { title: "Bleach", year: 1989, ratingKey: "1" },
    { title: "Nevermind", year: 1991, ratingKey: "2" },
  ]);

  assert.deepEqual(children.map((node) => [node.kind, node.title]), [
    ["album", "Bleach"],
    ["album", "Nevermind"],
    ["album", "In Utero"],
  ]);
});

test("only server-provided release categories create discography branches", () => {
  const children = buildDiscographyChildren([
    { title: "Nevermind", year: 1991, ratingKey: "1", releaseCategory: "Albums" },
    { title: "MTV Unplugged", year: 1994, ratingKey: "2", releaseCategory: "Live Albums" },
  ]);

  assert.deepEqual(children.map((node) => [node.kind, node.title]), [
    ["category", "Albums"],
    ["category", "Live Albums"],
  ]);
  assert.equal(children[1].children[0].title, "MTV Unplugged");
});

test("normalizes only nonempty album related hubs without leaking Plex response fields", () => {
  const groups = normalizeRelatedReleaseGroups([
    { type: "album", title: "Singles & EPs", Metadata: [{ title: "Sliver", year: 1990, ratingKey: "single-1", parentTitle: "Nirvana", thumb: "/private" }] },
    { type: "artist", title: "Similar Artists", Metadata: [{ title: "Pearl Jam", ratingKey: "artist-1" }] },
    { type: "album", title: "Demos", Metadata: [] },
  ]);

  assert.deepEqual(groups, [{
    title: "Singles & EPs",
    type: "album",
    albums: [{ title: "Sliver", year: 1990, ratingKey: "single-1", artist: "Nirvana" }],
  }]);
});

test("merges core albums with Plex release hubs in server order and removes duplicate rating keys", () => {
  const children = mergeDiscography(
    [
      { title: "Nevermind", year: 1991, ratingKey: "core-2", artist: "Nirvana" },
      { title: "Bleach", year: 1989, ratingKey: "core-1", artist: "Nirvana" },
    ],
    [
      { title: "Singles & EPs", albums: [
        { title: "Hormoaning", year: 1992, ratingKey: "single-1", artist: "Nirvana" },
        { title: "Nevermind duplicate", year: 1991, ratingKey: "core-2", artist: "Nirvana" },
      ] },
      { title: "Compilations", albums: [
        { title: "Nirvana", year: 2002, ratingKey: "comp-1", artist: "Nirvana" },
      ] },
    ]
  );

  assert.deepEqual(children.map((node) => [node.kind, node.title, node.children.length]), [
    ["category", "Albums", 2],
    ["category", "Singles & EPs", 1],
    ["category", "Compilations", 1],
  ]);
  assert.deepEqual(children[0].children.map((node) => node.title), ["Bleach", "Nevermind"]);
  assert.deepEqual(children[1].children.map((node) => node.title), ["Hormoaning"]);
});

test("ignores empty and non-album related groups before building artist categories", () => {
  const children = mergeDiscography([], [
    { title: "Similar Artists", type: "artist", albums: [{ title: "Pearl Jam", ratingKey: "artist-1" }] },
    { title: "Soundtracks", type: "album", albums: [] },
    { title: "Live Albums", type: "album", albums: [{ title: "Live at Reading", ratingKey: "live-1" }] },
  ]);

  assert.deepEqual(children.map((node) => [node.title, node.children.map((leaf) => leaf.title)]), [
    ["Live Albums", ["Live at Reading"]],
  ]);
});

test("visible rows and toggle state support tree keyboard traversal", () => {
  const tree = buildSearchTree({
    artists: [{ type: "artist", title: "Nirvana", ratingKey: "artist-1" }], albums: [], tracks: [],
  });
  tree[0].children = buildDiscographyChildren([{ title: "Bleach", year: 1989, ratingKey: "album-1" }]);
  let expanded = new Set();
  assert.deepEqual(visibleRows(tree, expanded).map((row) => row.node.title), ["Nirvana"]);
  expanded = toggleExpanded(expanded, "artist:artist-1");
  assert.deepEqual(visibleRows(tree, expanded).map((row) => row.node.title), ["Nirvana", "Bleach"]);
  expanded = toggleExpanded(expanded, "artist:artist-1");
  assert.deepEqual(visibleRows(tree, expanded).map((row) => row.node.title), ["Nirvana"]);
});

test("an artist discography load cannot be started twice while it is pending", () => {
  assert.equal(shouldLoadDiscography({ kind: "artist", children: null, loading: false }), true);
  assert.equal(shouldLoadDiscography({ kind: "artist", children: null, loading: true }), false);
  assert.equal(isDiscographyLoading({ kind: "artist", children: null, loading: true }), true);
  assert.equal(isDiscographyLoading({ kind: "artist", children: [] }), false);
  assert.equal(shouldLoadDiscography({ kind: "artist", children: [] }), false);
});
