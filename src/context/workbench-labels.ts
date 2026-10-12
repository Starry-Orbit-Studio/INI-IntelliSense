import { localize } from '../i18n';
import { WorkbenchLabels } from './workbench-protocol';

export function workbenchLabels(): WorkbenchLabels {
    return {
        setting_exePath: localize('workbench.setting_exePath', 'External validator executable'),
        setting_validationFolderPath: localize('workbench.setting_validationFolderPath', 'Mod project root'),
        setting_validationFiles: localize('workbench.setting_validationFiles', 'External validator input files'),
        'setting_indexing.fileCategories': localize(
            'workbench.setting_indexing.fileCategories',
            'File category matching rules'
        ),
        'setting_indexing.excludePatterns': localize(
            'workbench.setting_indexing.excludePatterns',
            'Excluded INI files'
        ),
        'setting_codeLens.enabled': localize('workbench.setting_codeLens.enabled', 'Reference counts above sections'),
        'setting_decorations.overrideIndicator.enabled': localize(
            'workbench.setting_decorations.overrideIndicator.enabled',
            'Inherited-key override marks'
        ),
        'setting_diagnostics.enabled': localize('workbench.setting_diagnostics.enabled', 'Live INI checks'),
        'setting_diagnostics.spaceBeforeEquals': localize(
            'workbench.setting_diagnostics.spaceBeforeEquals',
            'Legacy: space before equals'
        ),
        'setting_diagnostics.spaceAfterEquals': localize(
            'workbench.setting_diagnostics.spaceAfterEquals',
            'Legacy: space after equals'
        ),
        'setting_diagnostics.leadingWhitespace': localize(
            'workbench.setting_diagnostics.leadingWhitespace',
            'Legacy: leading whitespace'
        ),
        'setting_diagnostics.spacesBeforeComment': localize(
            'workbench.setting_diagnostics.spacesBeforeComment',
            'Expected spaces before comments'
        ),
        'setting_diagnostics.spaceAfterComment': localize(
            'workbench.setting_diagnostics.spaceAfterComment',
            'Legacy: space after comment marker'
        ),
        'setting_iniValidator.downloadUrl': localize(
            'workbench.setting_iniValidator.downloadUrl',
            'External validator download address'
        ),
        'setting_media.enabled': localize('workbench.setting_media.enabled', 'Asset workbench'),
        'setting_media.autoReveal': localize(
            'workbench.setting_media.autoReveal',
            'Automatically open the bottom inspector'
        ),
        'setting_media.inlineThumbnails': localize(
            'workbench.setting_media.inlineThumbnails',
            'Inline asset thumbnails'
        ),
        'setting_media.hoverEnabled': localize('workbench.setting_media.hoverEnabled', 'Asset hover previews'),
        'setting_media.theater': localize('workbench.setting_media.theater', 'Default theater'),
        'setting_media.semanticRules': localize(
            'workbench.setting_media.semanticRules',
            'Custom asset reference rules'
        ),
        'setting_project.objectColumns': localize(
            'workbench.setting_project.objectColumns',
            'Object attribute columns'
        ),
        'setting_diagnostics.excludePatterns': localize(
            'workbench.setting_diagnostics.excludePatterns',
            'Files excluded from live checks'
        ),
        'setting_diagnostics.overrides': localize(
            'workbench.setting_diagnostics.overrides',
            'Rule exceptions by file pattern'
        ),
        'setting_indexing.fileOverrides': localize(
            'workbench.setting_indexing.fileOverrides',
            'Per-file INI categories'
        ),
        'setting_decorations.booleanPreview.enabled': localize(
            'workbench.setting_decorations.booleanPreview.enabled',
            'Boolean value indicators'
        ),
        'setting_decorations.csfPreview.enabled': localize(
            'workbench.setting_decorations.csfPreview.enabled',
            'CSF inline text'
        ),
        'setting_decorations.csfPreview.maxLength': localize(
            'workbench.setting_decorations.csfPreview.maxLength',
            'CSF inline text length'
        ),
        'setting_project.compatibility': localize('workbench.setting_project.compatibility', 'INI compatibility mode'),
        standaloneContext: localize('workbench.standaloneContext', 'Standalone file context'),
        automaticContext: localize('workbench.automaticContext', 'Detected project entry context'),
        checksDisabled: localize('workbench.checksDisabled', 'Live INI checks are disabled'),
        configureFileCategory: localize('workbench.configureFileCategory', 'Set INI file category'),
        relation_typeMismatch: localize('workbench.relation_typeMismatch', 'Target type differs from the dictionary'),
        graphStale: localize('workbench.graphStale', 'The INI changed. Refresh to rebuild these relations.'),
        checkCenter: localize('workbench.checkCenter', 'INI check center'),
        logicChain: localize('workbench.logicChain', 'Logic chain'),
        scopeFolder: localize('workbench.scopeFolder', 'Current project folder'),
        scopeWorkspace: localize('workbench.scopeWorkspace', 'Workspace'),
        scopeUser: localize('workbench.scopeUser', 'User'),
        saveScope: localize('workbench.saveScope', 'Save configuration to'),
        runCurrent: localize('workbench.runCurrent', 'Check current file'),
        runProject: localize('workbench.runProject', 'Check project'),
        nativeSettings: localize('workbench.nativeSettings', 'Open VS Code settings'),
        checkComplete: localize('workbench.checkComplete', 'Check complete'),
        checkPartial: localize('workbench.checkPartial', 'Not fully checked'),
        checkResults: localize('workbench.checkResults', 'Results'),
        checkRules: localize('workbench.checkRules', 'Check rules'),
        searchChecks: localize('workbench.searchChecks', 'Search rules, settings or results'),
        noIssues: localize('workbench.noIssues', 'No issues found in the checked scope.'),
        noResults: localize('workbench.noResults', 'No results yet. Run a check or open an INI file.'),
        presetCompatible: localize('workbench.presetCompatible', 'Compatible defaults'),
        presetCorrectness: localize('workbench.presetCorrectness', 'Focus on correctness'),
        presetStrict: localize('workbench.presetStrict', 'Strict checks'),
        presetQuiet: localize('workbench.presetQuiet', 'Quiet editing'),
        ruleHelp: localize(
            'workbench.ruleHelp',
            'Choose the level for each rule. Inherit removes this scope’s override. Advanced file exceptions are available in settings.'
        ),
        default: localize('workbench.default', 'Default'),
        inheritSetting: localize('workbench.inheritSetting', 'Inherit setting'),
        level_Error: localize('workbench.level_Error', 'Error'),
        level_Warning: localize('workbench.level_Warning', 'Warning'),
        level_Information: localize('workbench.level_Information', 'Information'),
        level_Hint: localize('workbench.level_Hint', 'Hint'),
        level_None: localize('workbench.level_None', 'Off'),
        dictionaryMissing: localize('workbench.dictionaryMissing', 'Not configured / not loaded'),
        descriptionLanguages: localize('workbench.descriptionLanguages', 'Loaded description languages'),
        updateDictionary: localize('workbench.updateDictionary', 'Update dictionary'),
        externalValidator: localize('workbench.externalValidator', 'Manage external INI Validator'),
        bothDirections: localize('workbench.bothDirections', 'Both directions'),
        upstream: localize('workbench.upstream', 'Upstream · used by'),
        downstream: localize('workbench.downstream', 'Downstream · uses'),
        depth: localize('workbench.depth', 'Depth'),
        logicHelp: localize(
            'workbench.logicHelp',
            'Effective typed references. Click an object to explore it; click a source to open the producing tag. Conditions do not imply runtime execution.'
        ),
        graphTruncated: localize(
            'workbench.graphTruncated',
            'More branches exist. Expand depth or focus on a branch; up to 150 objects are shown.'
        ),
        missingTarget: localize('workbench.missingTarget', 'Target definition is missing in this context.'),
        noRelations: localize('workbench.noRelations', 'No direct relation in this direction.'),
        allRelations: localize('workbench.allRelations', 'Expanded relation paths'),
        relation_reference: localize('workbench.relation_reference', 'Reference'),
        relation_inheritance: localize('workbench.relation_inheritance', 'Inheritance'),
        relation_image: localize('workbench.relation_image', 'Art binding'),
        relation_sound: localize('workbench.relation_sound', 'Sound'),
        relation_condition: localize('workbench.relation_condition', 'Condition'),
        relation_inferred: localize('workbench.relation_inferred', 'Inferred reference'),

        group_game: localize('workbench.group_game', 'Units, buildings and superweapons'),
        group_all: localize('workbench.group_all', 'All definitions'),
        group_infantry: localize('workbench.group_infantry', 'Infantry'),
        group_vehicles: localize('workbench.group_vehicles', 'Vehicles'),
        group_aircraft: localize('workbench.group_aircraft', 'Aircraft'),
        group_buildings: localize('workbench.group_buildings', 'Buildings'),
        group_superweapons: localize('workbench.group_superweapons', 'Superweapons'),
        group_weapons: localize('workbench.group_weapons', 'Weapons'),
        group_warheads: localize('workbench.group_warheads', 'Warheads'),
        group_projectiles: localize('workbench.group_projectiles', 'Projectiles'),
        group_animations: localize('workbench.group_animations', 'Animations'),
        group_particles: localize('workbench.group_particles', 'Particles and systems'),
        group_sounds: localize('workbench.group_sounds', 'Sound events'),
        group_other: localize('workbench.group_other', 'Other definitions'),
        effects: localize('workbench.effects', 'Weapons and effects'),
        projectMaps: localize('workbench.projectMaps', 'Maps'),
        recentObjects: localize('workbench.recentObjects', 'Recently viewed'),
        openCatalog: localize('workbench.openCatalog', 'Open list / compare / batch edit'),
        openDefinition: localize('workbench.openDefinition', 'Open definition'),
        refineSearch: localize('workbench.refineSearch', 'Refine your search to see more results'),
        noObjects: localize(
            'workbench.noObjects',
            'No matching objects. Adjust the search or choose another category.'
        ),
        projectSettings: localize('workbench.projectSettings', 'Project overview and settings'),
        projectSources: localize('workbench.projectSources', 'Sources and index status'),
        looseResources: localize('workbench.looseResources', 'Indexed loose resource names'),
        archives: localize('workbench.archives', 'MIX archives'),
        projectIssues: localize('workbench.projectIssues', 'Index issues'),
        searchSources: localize('workbench.searchSources', 'Search INI source paths'),
        projectOverviewHelp: localize(
            'workbench.projectOverviewHelp',
            'Browse game content from the sidebar. Selecting an object opens its bottom-panel preview; source links open the INI definition.'
        ),
        projectSettingsHelp: localize(
            'workbench.projectSettingsHelp',
            'Values below are the effective configuration for this project. Edit opens workspace settings; preview colors and backgrounds remain personal preferences.'
        ),
        resourcePriorityHelp: localize(
            'workbench.resourcePriorityHelp',
            'The project root is searched first, followed by additional roots in order. Loose project assets precede archives; backup directories are fallback sources. Equal-priority candidates remain selectable in the object inspector.'
        ),
        'setting_project.entryPoints': localize('workbench.setting_project.entryPoints', 'Entry INIs and includes'),
        'help_project.entryPoints': localize(
            'workbench.help_project.entryPoints',
            'Select Rules, Art and Sound entry files. An empty configuration detects standard project entries. Included files are followed automatically; other files remain independent.'
        ),
        'setting_media.resourceRoots': localize(
            'workbench.setting_media.resourceRoots',
            'Additional resource directories'
        ),
        'help_media.resourceRoots': localize(
            'workbench.help_media.resourceRoots',
            'The project root is always included. Add directories in priority order; relative paths resolve against the project root.'
        ),
        'setting_media.archiveOrder': localize('workbench.setting_media.archiveOrder', 'Archive priority'),
        'help_media.archiveOrder': localize(
            'workbench.help_media.archiveOrder',
            'Set the archive search order when several MIX files contain the same asset.'
        ),
        'setting_media.excludedDirectories': localize(
            'workbench.setting_media.excludedDirectories',
            'Excluded directories'
        ),
        'help_media.excludedDirectories': localize(
            'workbench.help_media.excludedDirectories',
            'Exclude tool and cache directories from resource scanning.'
        ),
        setting_schemaFilePath: localize('workbench.setting_schemaFilePath', 'INI dictionary'),
        help_schemaFilePath: localize(
            'workbench.help_schemaFilePath',
            'Dictionary used for completion, types and reference resolution.'
        ),
        'setting_maps.renderer': localize('workbench.setting_maps.renderer', 'Full map renderer'),
        'help_maps.renderer': localize(
            'workbench.help_maps.renderer',
            'Optional CNCMaps worker and game resource configuration. Embedded map thumbnails work without it.'
        ),

        renderMap: localize('workbench.renderMap', 'Render current map'),
        configureMapRenderer: localize('workbench.configureMapRenderer', 'Configure map renderer'),
        mapSections: localize('workbench.mapSections', 'Map sections — open in editor'),
        embeddedMap: localize('workbench.embeddedMap', 'Embedded radar preview; it may not reflect unsaved changes.'),
        renderedMap: localize(
            'workbench.renderedMap',
            'Rendered from the current map text with the configured game resources.'
        ),
        mapRendererConfiguration: localize(
            'workbench.mapRendererConfiguration',
            'Configure an absolute map renderer executable and game MIX directory first.'
        ),
        mapRendererTimeout: localize('workbench.mapRendererTimeout', 'Map rendering exceeded the two-minute limit.'),
        mapRendererExited: localize('workbench.mapRendererExited', 'Map renderer exited before completion ({0}): {1}'),
        mapRendererProtocol: localize('workbench.mapRendererProtocol', 'Invalid map renderer response.'),
        mapRendererFailed: localize('workbench.mapRendererFailed', 'Map rendering failed: {0}'),
        mapImageLimit: localize('workbench.mapImageLimit', 'Rendered map exceeds the 64 MiB image limit.'),
        mapTrust: localize('workbench.mapTrust', 'Trust this workspace before running an external map renderer.'),
        indexLimit: localize(
            'workbench.indexLimit',
            'Only the first {0} INI files were indexed. Narrow the project resource roots.'
        ),
        backgroundImage: localize('workbench.backgroundImage', 'Image background'),
        backgroundSky: localize('workbench.backgroundSky', '360° panorama sky'),
        chooseBackground: localize('workbench.chooseBackground', 'Choose background image'),
        backgroundFailed: localize('workbench.backgroundFailed', 'Could not load background'),
        backgroundLimit: localize('workbench.backgroundLimit', 'Choose a PNG, JPEG or WebP image smaller than 8 MiB.'),
        backgroundHelp: localize(
            'workbench.backgroundHelp',
            'Session-only reference background. Use a 2:1 equirectangular image for the perspective sky. It does not change lighting or transparent PNG exports.'
        ),
        objects: localize('workbench.objects', 'Project objects'),
        searchObjects: localize('workbench.searchObjects', 'Search object ID, game name or source'),
        allCategories: localize('workbench.allCategories', 'All file categories'),
        allTypes: localize('workbench.allTypes', 'All object types'),
        favorites: localize('workbench.favorites', 'Favorites'),
        compareObjects: localize('workbench.compareObjects', 'Compare selected objects'),
        batchEdit: localize('workbench.batchEdit', 'Batch edit'),
        propertyKey: localize('workbench.propertyKey', 'Property'),
        operation: localize('workbench.operation', 'Operation'),
        newValue: localize('workbench.newValue', 'Value'),
        previewChanges: localize('workbench.previewChanges', 'Preview changes'),
        batch_set: localize('workbench.batch_set', 'Set value'),
        batch_add: localize('workbench.batch_add', 'Add amount'),
        batch_percent: localize('workbench.batch_percent', 'Adjust by percent'),
        batchHelp: localize(
            'workbench.batchHelp',
            'Changes are written to each selected object. Inherited values become local overrides. Integer types are rounded to the nearest integer. Preview and review every change before applying.'
        ),
        selectPage: localize('workbench.selectPage', 'Select this page'),
        previous: localize('workbench.previous', 'Previous page'),
        nextPage: localize('workbench.nextPage', 'Next page'),
        clearSelection: localize('workbench.clearSelection', 'Clear selection'),
        selected: localize('workbench.selected', 'Selected'),
        definitions: localize('workbench.definitions', 'Definitions'),
        onlyDifferences: localize('workbench.onlyDifferences', 'Only differences'),
        close: localize('workbench.close', 'Close'),
        column_name: localize('workbench.column_name', 'Object'),
        column_type: localize('workbench.column_type', 'Type'),
        column_category: localize('workbench.column_category', 'Category'),
        configuredContext: localize('workbench.configuredContext', 'Configured load context'),
        editorContext: localize('workbench.editorContext', 'Editor context'),
        documents: localize('workbench.documents', 'INI files'),
        indexIncomplete: localize('workbench.indexIncomplete', 'Index incomplete'),
        contextHelp: localize(
            'workbench.contextHelp',
            'Configure entry files separately from file categories. Active definitions use the loading chain; unloaded files are isolated. Review missing includes when the index is incomplete.'
        ),
        projectEntries: localize('workbench.projectEntries', 'Project entry INIs'),
        chooseEntries: localize(
            'workbench.chooseEntries',
            'Select the root rules, art and sound INIs; included files are followed automatically. Clear all to detect standard project entries.'
        ),
        duplicateEdit: localize(
            'workbench.duplicateEdit',
            'The change plan contains conflicting edits for the same property.'
        ),
        invalidPropertyValue: localize(
            'workbench.invalidPropertyValue',
            'The value does not satisfy the property type or range: {0}'
        ),
        editFailed: localize('workbench.editFailed', 'VS Code could not apply the change plan. No save was requested.'),
        unknownProperty: localize(
            'workbench.unknownProperty',
            'The property is neither declared on the object nor defined in its dictionary: {0}'
        ),
        editProperty: localize('workbench.editProperty', 'Edit'),
        writeTo: localize('workbench.writeTo', 'Write to'),
        cancel: localize('workbench.cancel', 'Cancel'),
        removeOverride: localize('workbench.removeOverride', 'Remove local declaration'),
        unsetValue: localize('workbench.unsetValue', 'Not explicitly defined; consult project defaults'),
        effective: localize('workbench.effective', 'Effective'),
        overridden: localize('workbench.overridden', 'Overridden'),
        searchPalette: localize('workbench.searchPalette', 'Search palettes and sources'),
        zoom: localize('workbench.zoom', 'Zoom ×'),
        theater: localize('workbench.theater', 'Theater'),
        theater_tem: localize('workbench.theater_tem', 'Temperate'),
        theater_sno: localize('workbench.theater_sno', 'Snow'),
        theater_urb: localize('workbench.theater_urb', 'Urban'),
        theater_ubn: localize('workbench.theater_ubn', 'New urban'),
        theater_lun: localize('workbench.theater_lun', 'Lunar'),
        theater_des: localize('workbench.theater_des', 'Desert'),
        spriteGestures: localize(
            'workbench.spriteGestures',
            'Wheel to zoom; drag or middle-drag to pan; reset to center.'
        ),
        voxelGestures: localize('workbench.voxelGestures', 'Wheel to zoom; drag to orbit; middle-drag to pan.'),
        title: localize('workbench.title', 'Object Inspector'),
        library: localize('workbench.library', 'Asset library'),
        body: localize('workbench.body', 'Body'),
        barrel: localize('workbench.barrel', 'Barrel'),
        empty: localize('workbench.empty', 'Place the cursor in an INI section or open a resource.'),
        loading: localize('workbench.loading', 'Resolving object and resources…'),
        pin: localize('workbench.pin', 'Pin'),
        follow: localize('workbench.follow', 'Follow cursor'),
        refresh: localize('workbench.refresh', 'Refresh'),
        back: localize('workbench.back', 'Back'),
        browse: localize('workbench.browse', 'Browse assets'),
        compare: localize('workbench.compare', 'Keep for comparison'),
        export: localize('workbench.export', 'Export PNG / WAV'),
        exportPng: localize('workbench.exportPng', 'Export PNG'),
        exportAudio: localize('workbench.exportAudio', 'Export audio'),
        altCameo: localize('workbench.altCameo', 'Promoted icon'),
        resetLight: localize('workbench.resetLight', 'Restore project lighting'),
        sourceFrame: localize('workbench.sourceFrame', 'Source frame'),
        damagePoints: localize('workbench.damagePoints', 'Damage effect points'),
        addPoint: localize('workbench.addPoint', 'Add to INI'),
        deletePoint: localize('workbench.deletePoint', 'Delete point'),
        properties: localize('workbench.properties', 'Effective properties'),
        references: localize('workbench.references', 'References'),
        source: localize('workbench.source', 'Source'),
        inherited: localize('workbench.inherited', 'Inherited'),
        palette: localize('workbench.palette', 'Palette'),
        automatic: localize('workbench.automatic', 'Automatic'),
        game: localize('workbench.game', 'Game view'),
        fit: localize('workbench.fit', 'Fit viewport'),
        defaultLight: localize('workbench.defaultLight', 'Game lighting'),
        projectLight: localize('workbench.projectLight', 'Project lighting'),
        lightGizmo: localize('workbench.lightGizmo', 'Drag light orb'),
        sceneState: localize('workbench.sceneState', 'Scene state'),
        layers: localize('workbench.layers', 'Scene layers'),
        trace: localize('workbench.trace', 'Resolution trace'),
        foundation: localize('workbench.foundation', 'Foundation grid'),
        normalScene: localize('workbench.normalScene', 'Completed'),
        damaged: localize('workbench.damaged', 'Damaged'),
        construction: localize('workbench.construction', 'Construction'),
        special: localize('workbench.special', 'Special animation'),
        super: localize('workbench.super', 'Superweapon animation'),
        deploying: localize('workbench.deploying', 'Deploying animation'),
        powerup: localize('workbench.powerup', 'Upgrade animation'),
        production: localize('workbench.production', 'Production'),
        idle: localize('workbench.idle', 'Idle'),
        next: localize('workbench.next', 'Next animation'),
        backup: localize('workbench.backup', 'Backup source'),
        archive: localize('workbench.archive', 'Archive source'),
        project: localize('workbench.project', 'Project source'),
        perspective: localize('workbench.perspective', 'Perspective view'),
        normal: localize('workbench.normal', 'Normals'),
        slice: localize('workbench.slice', 'Slice'),
        play: localize('workbench.play', 'Play / Pause'),
        frame: localize('workbench.frame', 'Frame'),
        direction: localize('workbench.direction', 'Direction'),
        speed: localize('workbench.speed', 'Speed'),
        sequence: localize('workbench.sequence', 'Action'),
        raw: localize('workbench.raw', 'All frames'),
        shadow: localize('workbench.shadow', 'Shadow'),
        remap: localize('workbench.remap', 'House color'),
        background: localize('workbench.background', 'Background'),
        apply: localize('workbench.apply', 'Apply to INI'),
        start: localize('workbench.start', 'Start'),
        count: localize('workbench.count', 'Count'),
        stride: localize('workbench.stride', 'Direction stride'),
        shared: localize('workbench.shared', 'Objects sharing this sequence'),
        invalidSequence: localize('workbench.invalidSequence', 'Sequence exceeds available frames.'),
        light: localize('workbench.light', 'Light direction'),
        reset: localize('workbench.reset', 'Reset view'),
        fixed: localize('workbench.fixed', 'Fixed voxel lighting'),
        turret: localize('workbench.turret', 'Turret heading'),
        fireAngle: localize('workbench.fireAngle', 'Barrel elevation (FireAngle: 0–64)'),
        points: localize('workbench.points', 'Firing points'),
        dragPoint: localize(
            'workbench.dragPoint',
            'Drag a marker to move the point; drag F/L/H handles to constrain its axis.'
        ),
        showPoints: localize('workbench.showPoints', 'Show FLH points'),
        selectPoint: localize('workbench.selectPoint', 'Select a point to edit'),
        fire: localize('workbench.fire', 'Show firing ray'),
        flhScale: localize('workbench.flhScale', 'Leptons per voxel unit'),
        grid: localize('workbench.grid', 'Grid'),
        parts: localize('workbench.parts', 'Parts'),
        missing: localize('workbench.missing', 'No preview available'),
        random: localize('workbench.random', 'Random sample'),
        stop: localize('workbench.stop', 'Stop'),
        volume: localize('workbench.volume', 'Audition volume'),
        contact: localize('workbench.contact', 'Contact sheet'),
        visual: localize('workbench.visual', 'Preview'),
        attributes: localize('workbench.attributes', 'Attributes'),
        links: localize('workbench.links', 'References & sources'),
        snapshot: localize('workbench.snapshot', 'Comparison'),
        clearComparison: localize('workbench.clearComparison', 'Clear comparison'),
        cameo: localize('workbench.cameo', 'Icon'),
        filter: localize('workbench.filter', 'Filter'),
        uncalibrated: localize('workbench.uncalibrated', 'Preview approximation; verify final appearance in game.'),
        replacement: localize('workbench.replacement', 'Replace reference'),
        audit: localize('workbench.audit', 'Check project resources'),
    };
}
