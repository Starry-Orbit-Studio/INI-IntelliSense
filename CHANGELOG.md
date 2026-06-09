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
- Aligned the VXL/HVA game-view camera matrix and lighting transform more closely with RA2ArtStudio so directional light and screen-up vectors follow the same axis order and sign conventions.
- Updated VXL/HVA game-view interaction to keep a fixed gameplay camera while rotating the voxel model itself, and tightened lighting output so the final brightness follows the VPL lookup more closely.
- Simplified the resource preview UI by removing redundant reset/auto-palette affordances, moving multi-limb selection into an in-frame overlay list, and tightening preview layout so the canvas adapts better to smaller editor sizes.
- Refined voxel preview presentation with centered slice canvases, compact slice step buttons, and more consistent perspective-mode lighting based on rotated world-space normals.
- Switched the default VXL/HVA opening mode from slice view to game view so voxel resources open directly into the more representative gameplay-style preview.
