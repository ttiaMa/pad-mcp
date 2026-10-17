# Bundled PAD reference catalogs

These four JSON files are unmodified copies from [JoeG592/pad-robin-action-kb](https://github.com/JoeG592/pad-robin-action-kb), commit `0c4ebca091d270f2ddaa70bbda32240251cf0850`, retrieved on 2026-10-17. Copyright (c) 2026 Joe Green; licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The upstream [LICENSE](LICENSE) is included.

`metadata.json` records the immutable upstream commit, retrieval time and SHA-256 of each original file. Git preserves the JSON bytes across platforms so checksum validation also works after a Windows checkout. Both editions are parsed and verified before use.

pad-mcp can use these catalogs immediately without GitHub access. Maintainer-approved updates are stored under `CATALOG_CACHE_PATH` and take precedence over this bundle; they do not rewrite the installed application or Docker image. See [catalog lifecycle](../docs/catalog.md#stage-2-persistent-catalog-cache).
