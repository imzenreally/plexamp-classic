/* Pure search-tree transformation/state helpers shared by tests and library UI. */
(function exposeSearchTree(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.SearchTree = api;
})(typeof window === "undefined" ? null : window, () => {
  function nodeId(kind, item, fallback) {
    return `${kind}:${item.ratingKey || fallback}`;
  }

  function albumNode(album) {
    return {
      id: nodeId("album", album, `${album.title}:${album.year || ""}`),
      kind: "album",
      title: album.title,
      item: album,
      children: [],
    };
  }

  function buildDiscographyChildren(albums) {
    const sorted = [...albums].sort((a, b) =>
      Number(a.year || 9999) - Number(b.year || 9999) || String(a.title).localeCompare(String(b.title))
    );
    // Plex artist children do not expose release grouping on all servers. Do
    // not infer categories from names, year, genre, or global search hubs.
    const hasCategories = sorted.length > 0 && sorted.every((album) => album.releaseCategory);
    if (!hasCategories) return sorted.map(albumNode);

    const groups = new Map();
    for (const album of sorted) {
      const category = album.releaseCategory;
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(albumNode(album));
    }
    return [...groups.entries()].map(([title, children]) => ({
      id: `category:${title}`,
      kind: "category",
      title,
      children,
    }));
  }

  function normalizeRelatedReleaseGroups(hubs) {
    return (hubs || [])
      .filter((hub) => hub?.type === "album" && hub.title && Array.isArray(hub.Metadata) && hub.Metadata.length)
      .map((hub) => ({
        title: hub.title,
        type: "album",
        albums: hub.Metadata
          .filter((album) => album?.title && album.ratingKey)
          .map((album) => ({
            title: album.title,
            year: album.year || "",
            ratingKey: album.ratingKey,
            artist: album.parentTitle || album.grandparentTitle || "",
          })),
      }))
      .filter((group) => group.albums.length);
  }

  function categoryNode(title, albums) {
    return {
      id: `category:${title}`,
      kind: "category",
      title,
      children: albums.map(albumNode),
    };
  }

  function mergeDiscography(coreAlbums, relatedGroups) {
    const seenRatingKeys = new Set();
    const uniqueAlbums = (albums) => (albums || []).filter((album) => {
      if (!album?.ratingKey || seenRatingKeys.has(album.ratingKey)) return false;
      seenRatingKeys.add(album.ratingKey);
      return true;
    });
    const children = [];
    const core = uniqueAlbums([...coreAlbums].sort((a, b) =>
      Number(a.year || 9999) - Number(b.year || 9999) || String(a.title).localeCompare(String(b.title))
    ));
    if (core.length) children.push(categoryNode("Albums", core));
    for (const group of relatedGroups || []) {
      if (group?.type && group.type !== "album") continue;
      const albums = uniqueAlbums(group?.albums);
      if (group?.title && albums.length) children.push(categoryNode(group.title, albums));
    }
    return children;
  }

  function buildSearchTree(results) {
    const artists = (results.artists || []).map((artist) => ({
      id: nodeId("artist", artist, artist.title),
      kind: "artist",
      title: artist.title,
      item: artist,
      children: null, // lazy discography load
    }));
    const otherChildren = [
      ...(results.albums || []).map((album) => ({
        id: nodeId("other-album", album, `${album.title}:${album.artist || ""}`),
        kind: "album",
        title: album.title,
        item: album,
        children: [],
      })),
      ...(results.tracks || []).map((track) => ({
        id: nodeId("track", track, `${track.title}:${track.artist || ""}`),
        kind: "track",
        title: track.title,
        item: track,
        children: [],
      })),
    ];
    if (otherChildren.length) artists.push({
      id: "other",
      kind: "other",
      title: "Other matching releases/tracks",
      children: otherChildren,
    });
    return artists;
  }

  function isDiscographyLoading(node) {
    return node?.kind === "artist" && node.loading === true;
  }

  function shouldLoadDiscography(node) {
    return node?.kind === "artist" && node.children === null && !node.loading;
  }

  function visibleRows(nodes, expanded, depth = 0, rows = []) {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (expanded.has(node.id) && Array.isArray(node.children)) {
        visibleRows(node.children, expanded, depth + 1, rows);
      }
    }
    return rows;
  }

  function toggleExpanded(expanded, id) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  return { buildSearchTree, buildDiscographyChildren, normalizeRelatedReleaseGroups, mergeDiscography, isDiscographyLoading, shouldLoadDiscography, visibleRows, toggleExpanded };
});
