[Read this in Chinese (简体中文)](./CHANGELOG.zh-cn.md)

# Change Log

All notable changes to the "ra2-ini-intellisense" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release
- Added first-class MIX archive browsing with a virtual `ra2mix:` file system, lazy-loaded MIX/INI resource views, and open-as-workspace support for `.mix` files.
- Added default-open resource previews for `pcx`, `pal`, `map`, `shp`, `vxl`, and `hva`, with theme-aware centered rendering and SHP palette selection support.
- Upgraded VXL/HVA perspective previews with orbit, pan, zoom, limb switching, and camera reset controls for a more editor-like 3D inspection workflow.
- Switched SHP/VXL/HVA palette fallback from a grayscale placeholder to a bundled real `unittem.pal` taken from the RA2ArtStudio palette set.
