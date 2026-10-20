/**
 * Client half of the user portrait plugin: the review and correction panel.
 *
 * The panel renders inside the right sidebar's tab seat, so it inherits the
 * host's theme tokens, dark/light switching, and layout. It talks to the Host
 * half through the package's own HTTP route, which serves exactly the
 * operations the agent tools use.
 *
 * Visual language: the panel follows the desktop app's own primitives — the
 * `Button` geometry (28px `sm` controls, 8px corners, transparent/outline/
 * primary fills and the `interactive-bg-hover` hover), the segmented tab
 * indicator, `Tag`-shaped status chips, and the settings form's 34px fields.
 * Those are re-implemented to the official measurements rather than imported:
 * this half runs on the module table, whose only seed words are React, cordis,
 * the client store, the slots service, and the UI primitives — and that
 * primitives module cannot be required here, because its own top-level imports
 * (`react-dom`, `katex`, `shiki/core`) are not seed words.
 *
 * No Harness Client package is imported at module scope: React comes from the
 * module loader's browser module table.
 */

window.__ModuleLoader__.load({
  id: 'dsh-user-portrait',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Package id, stamped on the stylesheet so unload can collect it. */
    const PLUGIN_ID = 'dsh-user-portrait';

    /** How long a finished backfill result stays on screen. */
    const BACKFILL_BANNER_MS = 8000;

    /**
     * The official product-icon geometry, inlined as path data.
     *
     * These are the exact `*Regular` outlines of the desktop app's primitives
     * package (16x16 viewBox, 1px stroke, `currentColor`). They are inlined on
     * purpose: the platform seed publishes
     * `@deepseek-ai/dsh-client-ui-primitives` as a static module-table entry, but
     * that module's own top-level imports (`react-dom`, `katex`, `shiki/core`)
     * are not seed words, so requiring it from a plugin throws inside the client
     * module table — and the slot service answers a throwing entry by dropping
     * it, which renders the pane blank. Copying the geometry keeps the official
     * look with no module-resolution risk.
     */
    const GLYPHS = {
      sparkle: {
        paths: [
          'M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z',
          'M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z',
          'M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z',
        ],
      },
      archive: {
        paths: [
          'M13.5 2.5H2.5C1.94772 2.5 1.5 2.94772 1.5 3.5V4.5C1.5 5.05228 1.94772 5.5 2.5 5.5H13.5C14.0523 5.5 14.5 5.05228 14.5 4.5V3.5C14.5 2.94772 14.0523 2.5 13.5 2.5Z',
          'M2.5 5.5V13.5C2.5 13.7652 2.60536 14.0196 2.79289 14.2071C2.98043 14.3946 3.23478 14.5 3.5 14.5H12.5C12.7652 14.5 13.0196 14.3946 13.2071 14.2071C13.3946 14.0196 13.5 13.7652 13.5 13.5V5.5',
          'M6.5 9.5H9.5',
        ],
      },
      refresh: {
        paths: [
          'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1',
          'M14.4999 1.5V5.1H10.8999',
        ],
      },
      settings: {
        paths: [
          'M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z',
          'M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z',
        ],
        miterlimit: '10',
      },
      search: {
        paths: [
          'M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z',
          'M10.2991 10.3933L14.7783 14.8725',
        ],
      },
      trash: {
        paths: [
          'M1.28149 3.88831H14.7187',
          'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
          'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
          'M6.44946 6.98926V11.1238',
          'M9.55054 6.98926V11.1238',
        ],
      },
      user: {
        paths: [
          'M8 8.25C9.51878 8.25 10.75 7.01878 10.75 5.5C10.75 3.98122 9.51878 2.75 8 2.75C6.48122 2.75 5.25 3.98122 5.25 5.5C5.25 7.01878 6.48122 8.25 8 8.25Z',
          'M2.5 14.5C2.5 11.5 5.25 10.25 8 10.25C10.75 10.25 13.5 11.5 13.5 14.5',
        ],
      },
      plus: { paths: ['M8 2V14', 'M2 8H14'] },
      close: { paths: ['M2.5 2.5L13.5 13.5', 'M13.5 2.5L2.5 13.5'] },
      chevronUp: { paths: ['M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10'] },
    };

    /**
     * Render one official-geometry glyph at the control icon size.
     * @param name - key into {@link GLYPHS}.
     * @param size - rendered edge length in px.
     * @returns the inline SVG element.
     */
    function glyph(name, size = 14) {
      const artwork = GLYPHS[name];
      if (artwork === undefined) return null;
      return h(
        'svg',
        {
          className: 'dup-icon',
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          strokeWidth: 1,
          strokeMiterlimit: artwork.miterlimit,
        },
        ...artwork.paths.map((d, index) =>
          h('path', { key: index, d, stroke: 'currentColor', strokeMiterlimit: artwork.miterlimit }),
        ),
      );
    }

    /** Tab kind this plugin contributes to the right sidebar. */
    const TAB_KIND = 'user-portrait';
    /** The route the Host half registers. */
    const ENDPOINT = '/api/user-portrait';

    /** Fallback catalog and groups, used until the first Host payload arrives. */
    const FALLBACK_DIMENSIONS = [
      { id: 'personality', group: 'daily', label: '性格与沟通' },
      { id: 'interests', group: 'daily', label: '兴趣与爱好' },
      { id: 'background', group: 'daily', label: '生活与身份' },
      { id: 'focus', group: 'daily', label: '当前在做' },
      { id: 'current', group: 'daily', label: '近期状态' },
      { id: 'skill', group: 'tech', label: '能力与技术栈' },
      { id: 'workstyle', group: 'tech', label: '工作方式' },
      { id: 'boundary', group: 'tech', label: '风险边界' },
      { id: 'friction', group: 'tech', label: '敏感点' },
    ];
    const FALLBACK_GROUPS = [
      { id: 'daily', label: '日常画像', hint: '性格、爱好、生活背景与当前状态' },
      { id: 'tech', label: '技术画像', hint: '能力与技术栈、工作方式、风险边界与敏感点' },
    ];

    const CONFIDENCE_LABEL = { high: '高', medium: '中', low: '低' };
    const STATUS_LABEL = { active: '生效', superseded: '已取代', retired: '已废弃' };
    // Low confidence reads as a warning (red), high as solid (green) — the same
    // Tag geometry, only the tone differs.
    const CONFIDENCE_TONE = { high: 'success', medium: 'warning', low: 'low' };

    /**
     * The confidence one step away from the current one.
     * @param value - current confidence.
     * @param direction - `up` raises, `down` lowers.
     * @returns the neighbouring confidence.
     */
    function nextConfidence(value, direction) {
      const ladder = ['low', 'medium', 'high'];
      const index = ladder.indexOf(value);
      const at = index === -1 ? 1 : index;
      const step = direction === 'down' ? -1 : 1;
      return ladder[Math.max(0, Math.min(ladder.length - 1, at + step))];
    }

    /** The `data-plugin-css` value identifying this panel's one stylesheet. */
    const STYLE_TAG_ID = `${PLUGIN_ID}/panel.css`;

    /**
     * The panel stylesheet. Every value rides a theme token so the panel follows
     * the app's light/dark switch and palette changes without its own copy of
     * the color scale.
     */
    const CSS = `
/* The root fills the pane, and keeps a usable floor of its own so a pane that
 * hands down no height can never collapse the panel into blankness. */
.dup-root{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px}
.dup-head{padding:12px 14px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dup-title-row{display:flex;align-items:center;gap:8px;min-height:28px}
.dup-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;line-height:22px;flex:1;min-width:0}
.dup-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}
.dup-meta{margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dup-meta-line{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.6;margin-top:2px;word-break:break-all}
.dup-toolbar{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}

/* Controls: the app's compact (sm) button geometry — 28px, 8px corners. */
.dup-btn{box-sizing:border-box;appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease}
.dup-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dup-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dup-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dup-btn:disabled{opacity:.4;cursor:not-allowed}
.dup-btn[data-variant=primary]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dup-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dup-btn[data-variant=outline]{border:0.5px solid var(--dsw-alias-border-l3)}
.dup-btn[data-variant=toolbar]{background:var(--dsw-alias-button-tool-bar-fill)}
.dup-btn[data-variant=toolbar]:hover:not(:disabled){background:var(--dsw-alias-button-tool-bar-hover)}
.dup-btn[data-variant=icon]{width:28px;padding:0;color:var(--dsw-alias-label-secondary)}
.dup-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:14px;height:14px}
.dup-icon svg{display:block}

.dup-body{flex:1;min-height:0;overflow:auto;padding:10px 12px 28px}
.dup-section{margin-bottom:14px}
.dup-section-head{display:flex;align-items:center;gap:8px;padding:8px 2px;position:sticky;top:0;background:var(--dsw-alias-bg-base);z-index:1}
.dup-section-name{font-weight:600;font-size:13px;line-height:20px}
.dup-section-count{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.dup-group{margin:2px 0 18px}
.dup-group-head{display:flex;align-items:baseline;gap:8px;padding:0 2px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l1);margin-bottom:10px}
.dup-group-name{font-size:13px;font-weight:600;line-height:20px}
.dup-group-hint{margin:4px 2px 10px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.6}
.dup-group-total{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}

.dup-entry{border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:10px 12px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}
.dup-entry:hover{border-color:var(--dsw-alias-border-l2)}
.dup-entry[data-status=superseded],.dup-entry[data-status=retired]{opacity:.62}
.dup-entry-text{line-height:1.6;word-break:break-word}
.dup-entry-foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dup-src{margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.6;word-break:break-word}
/* A search hit: the matched substring is marked with the brand tint, not a
 * hard-coded yellow, so it follows the theme. */
.dup-mark{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent);color:inherit;border-radius:2px;padding:0 1px}
.dup-entry[data-kind=search-hit]{cursor:pointer}
.dup-entry[data-kind=search-hit]:hover{border-color:var(--dsw-alias-state-business-primary)}
/* The出处 reads as a count; hovering it reveals sessions, turns and the excerpt. */
.dup-src-count{cursor:help;border-bottom:1px dashed var(--dsw-alias-border-l3);padding-bottom:1px}
.dup-src-count:hover{color:var(--dsw-alias-label-secondary);border-bottom-color:var(--dsw-alias-border-l4)}
.dup-entry-actions{display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin-top:8px}
.dup-entry-menu{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:8px;padding:6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l1)}
.dup-entry-menu .dup-mini{opacity:1}

/* Composer portrait switch: a compact pill next to the permission selector. */
.dup-mode{position:relative;display:inline-flex;align-items:center}
.dup-mode-trigger{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 10px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;transition:background-color 120ms ease,color 120ms ease,border-color 120ms ease}
.dup-mode-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dup-mode-trigger[data-on=true]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}
.dup-mode-dot{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-border-l4)}
.dup-mode-dot[data-on=true]{background:var(--dsw-alias-state-business-primary)}
.dup-mode-pop{position:absolute;bottom:calc(100% + 6px);left:0;z-index:40;width:236px;padding:8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2);box-shadow:0 8px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.dup-mode-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 4px}
.dup-mode-label{display:flex;flex-direction:column;gap:1px;min-width:0}
.dup-mode-name{font-size:12px;color:var(--dsw-alias-label-primary)}
.dup-mode-hint{font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dup-mode-switch{position:relative;flex:none;width:30px;height:16px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-module-platform);cursor:pointer;padding:0;transition:background-color 120ms ease}
.dup-mode-switch::after{content:'';position:absolute;top:1px;left:1px;width:12px;height:12px;border-radius:999px;background:var(--dsw-alias-label-tertiary);transition:transform 120ms ease,background-color 120ms ease}
.dup-mode-switch[data-on=true]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.dup-mode-switch[data-on=true]::after{transform:translateX(14px);background:var(--dsw-alias-label-primary-foreground)}
.dup-mode-switch:disabled{opacity:.45;cursor:default}
.dup-mode-foot{margin-top:4px;padding:4px;font-size:10px;color:var(--dsw-alias-label-tertiary)}

/* Status chips follow the Tag geometry: 17px line, 11px text, fully round. */
.dup-chip{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap}
/* The 编辑 control is a chip-sized button rather than a mini text link: same
   geometry as the confidence badge, filled with the primary colour and the
   foreground token that is white on that fill in the light theme. */
.dup-edit-chip{display:inline-flex;align-items:center;border:0;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;cursor:pointer;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);transition:background-color 120ms ease,opacity 120ms ease}
.dup-edit-chip:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dup-edit-chip:disabled{opacity:.5;cursor:default}
.dup-edit-chip[data-open=true]{background:var(--dsw-alias-button-primary-hover)}
.dup-chip[data-tone=outline]{border:0.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}
.dup-chip[data-tone=neutral]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.dup-chip[data-tone=quiet]{color:var(--dsw-alias-label-tertiary)}
.dup-chip[data-tone=low]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.dup-chip[data-tone=success]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}
.dup-chip[data-tone=info]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary)}
.dup-chip[data-tone=warning]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}
/* A mixed basis: part user words, part model inference. Tinted with both signals
 * (business for the user's side, warn for the inference) so it reads as its own
 * state rather than as one of the two. */
.dup-chip[data-tone=mixed]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-label-secondary);border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent)}
.dup-chip[data-tone=danger]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}

/* Row actions: 24px ghost icon-buttons revealed on hover or focus. */
.dup-mini{box-sizing:border-box;appearance:none;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;line-height:17px;cursor:pointer}
.dup-entry-actions .dup-mini{opacity:0;transition:opacity 120ms ease,background-color 120ms ease,color 120ms ease}
.dup-entry:hover .dup-mini,.dup-entry:focus-within .dup-mini{opacity:1}
.dup-mini:hover:not(:disabled){background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-primary)}
.dup-mini:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dup-mini:disabled{opacity:.4;cursor:not-allowed}
.dup-mini[data-variant=danger]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-label-error)}
.dup-mini[data-variant=keep]{opacity:1}
/* The confidence controls stay visible: raising and lowering a conclusion is a
 * first-class action, not a hover discovery. Editing and deleting still reveal on
 * hover, so a row reads as a conclusion first. */
.dup-entry-actions .dup-mini[data-variant=confidence]{opacity:1;color:var(--dsw-alias-label-secondary)}

/* Fields: the settings form's control geometry. */
.dup-input,.dup-textarea,.dup-select{box-sizing:border-box;width:100%;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:0 12px;font-family:inherit;font-size:13px;line-height:34px;height:34px}
.dup-textarea{min-height:72px;padding:8px 12px;line-height:1.6;height:auto;resize:vertical}
.dup-input::placeholder,.dup-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}
.dup-input:focus-visible,.dup-textarea:focus-visible,.dup-select:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dup-field-row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}

.dup-row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.dup-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;padding:6px 2px}
.dup-turn{border-left:2px solid var(--dsw-alias-border-l2);padding:2px 0 2px 10px;margin-bottom:10px}
.dup-turn-q{line-height:1.6;word-break:break-word}
.dup-turn-a{color:var(--dsw-alias-label-secondary);margin-top:4px;line-height:1.6;word-break:break-word}
.dup-pre{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);margin:6px 0 0}

/* Tabs: the segmented-tab track with a sliding raised indicator. */
.dup-tabs{position:relative;display:flex;gap:2px;margin-top:10px;padding:4px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform)}
.dup-tab-indicator{position:absolute;top:4px;bottom:4px;left:4px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);transition:transform 180ms ease,width 180ms ease;pointer-events:none}
.dup-tab{position:relative;z-index:1;box-sizing:border-box;appearance:none;flex:1 1 0;min-width:0;display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 6px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;transition:color 180ms ease}
.dup-tab:hover{color:var(--dsw-alias-label-primary)}
.dup-tab[data-active=true]{color:var(--dsw-alias-label-primary);font-weight:600}
.dup-tab:focus-visible{outline:none;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:4px}

/* Status bars: tinted state surface with a solid leading edge. */
.dup-status{display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 10px;border-left:2px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dup-status[data-tone=success]{border-left-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}
.dup-status[data-tone=error]{border-left-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.dup-status[data-tone=info]{border-left-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary)}
.dup-status[data-tone=warning]{border-left-color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dup-status-text{min-width:0;word-break:break-word}
.dup-progress{flex:none;width:60px;height:3px;border-radius:999px;background:color-mix(in srgb,currentColor 20%,transparent);overflow:hidden}
.dup-progress > span{display:block;height:100%;border-radius:999px;background:currentColor}

/* One overlay for both dialogs (导出 / 结论上限). */
.dup-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent)}
.dup-dialog{width:100%;max-width:420px;max-height:min(76vh,620px);display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2);box-shadow:0 12px 40px color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);overflow:auto}
.dup-dialog-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dup-dialog-hint{font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}
.dup-option{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary);padding:4px 0}
.dup-option[data-locked=true]{color:var(--dsw-alias-label-tertiary)}
.dup-cap-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.dup-cap-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dup-cap-field input{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px}
.dup-cap-usage{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.7}
.dup-cap-usage[data-over=true]{color:var(--dsw-alias-state-error-primary)}

/* First paint: quiet skeleton rows instead of a bare sentence. */
.dup-skeleton{height:56px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l1);margin-bottom:8px;opacity:.7}
@media (prefers-reduced-motion:reduce){.dup-tab,.dup-tab-indicator,.dup-mini,.dup-entry-actions .dup-mini{transition:none}}
`;

    /**
     * Put the panel stylesheet into the document exactly once.
     *
     * A client plugin owns its own style tag: there is no `styles` module word
     * on the module table, so the built-in client bundles all append a
     * `<style data-plugin data-plugin-css>` tag themselves. `data-plugin` is also
     * the attribute the module system collects on unload, so reloading the
     * package cannot leave a stale copy behind.
     */
    function installStylesheet() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = STYLE_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** Reports already sent this page load, so the channel cannot spam the Host. */
    const reported = new Set();

    /**
     * Send one self-report to the Host.
     *
     * A failure inside the renderer is invisible from the Host: the slot service
     * isolates a throwing entry, so a blank pane writes nothing to any log. The
     * client therefore reports the facts only it can see — the registration keys
     * it used, whether the seats took them, whether the stylesheet landed, and
     * whether the panel mounted. The Host stores them in
     * `<dataDir>/client-report.json`, readable with `?view=report`.
     *
     * @param stage - short label for this report, e.g. `apply` or `mounted`.
     * @param detail - additional fields to include.
     */
    function reportToHost(stage, detail) {
      if (reported.has(stage)) return;
      reported.add(stage);
      try {
        const payload = {
          stage,
          at: Date.now(),
          href: typeof window === 'undefined' ? '' : String(window.location?.href ?? ''),
          dataKeys: detail?.dataKeys ?? undefined,
          ...detail,
        };
        void fetch(new URL(ENDPOINT, window.location.origin), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'report', report: payload }),
        }).catch(() => undefined);
      } catch {
        // Diagnostics must never break the panel.
      }
    }

    /** Remove this panel's stylesheet, if the document still holds it. */
    function removeStylesheet() {
      if (typeof document === 'undefined') return;
      for (const tag of document.querySelectorAll('style[data-plugin-css]')) {
        if (tag.getAttribute('data-plugin-css') === STYLE_TAG_ID) tag.remove();
      }
    }

    /**
     * Talk to the Host half.
     * @param options - request method, query, and JSON body.
     * @returns the parsed payload.
     */
    async function call(options) {
      const url = new URL(ENDPOINT, window.location.origin);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
      const init = { method: options.method ?? 'GET', headers: { accept: 'application/json' } };
      if (options.body !== undefined) {
        init.method = 'POST';
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(url, init);
      const payload = await response.json().catch(() => undefined);
      if (payload === undefined) throw new Error(`Host 返回了无法解析的响应 (HTTP ${response.status})`);
      if (payload.ok === false) throw new Error(payload.error ?? '未知错误');
      return payload;
    }

    /**
     * Format an epoch reading for display.
     * @param value - epoch milliseconds.
     * @returns a local timestamp.
     */
    function when(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
      const date = new Date(value);
      const pad = (part) => String(part).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /**
     * Build the hover card for one entry's sources.
     *
     * The panel shows only "来源 N 处"; the exact sessions, turns, timestamps and
     * the original excerpt live here, so they are one hover away instead of on
     * screen — and the excerpt is still readable when it is actually needed.
     *
     * @param entry - the profile entry.
     * @returns tooltip text, one source per line.
     */
    function sourceTooltip(entry) {
      const sources = entry.sources ?? [];
      if (sources.length === 0) return '这条结论没有记录来源';
      const lines = sources.slice(0, 8).map((source) => {
        const where = `${source.sessionId ?? '未知会话'}${source.turn === undefined ? '' : ` · 第 ${source.turn} 轮`}`;
        const at = source.at === undefined ? '' : ` · ${when(source.at)}`;
        const excerpt = typeof source.text === 'string' && source.text !== '' ? `\n    原文：${source.text}` : '';
        return `· ${where}${at}${excerpt}`;
      });
      if (sources.length > 8) lines.push(`… 另有 ${sources.length - 8} 处`);
      return `来源（${sources.length} 处）：\n${lines.join('\n')}`;
    }

    /**
     * One official-geometry button.
     * @param props - variant, click handler, disabled flag, label, and icon name.
     * @returns the button element.
     */
    function Button({ variant, onClick, disabled, label, iconName, title }) {
      const artwork = iconName === undefined ? null : glyph(iconName);
      return h(
        'button',
        {
          type: 'button',
          className: 'dup-btn',
          'data-variant': variant,
          disabled: disabled === true,
          title,
          'aria-label': title,
          onClick,
        },
        artwork,
        label === undefined || label === '' ? null : h('span', {}, label),
      );
    }

    /**
     * One Tag-shaped status chip.
     * @param props - tone, label, and an optional title.
     * @returns the chip element.
     */
    function Chip({ tone, children, title }) {
      return h('span', { className: 'dup-chip', 'data-tone': tone, title }, children);
    }

    /** How each basis is worded in the panel. */
    const BASIS_LABEL = {
      user: '依据 · 用户的话',
      assistant: '依据 · 模型应答',
      // A merge of both bases says so: dropping either half would misreport where
      // the conclusion came from.
      mixed: '依据 · 用户的话 & 模型应答',
    };

    /** The tone each basis is painted with. */
    const BASIS_TONE = { user: 'info', assistant: 'warning', mixed: 'mixed' };

    /** The hover text explaining each basis. */
    const BASIS_TITLE = {
      user: '依据出自用户自己的原话',
      assistant: '依据出自模型自己的回答/解释，不是用户明说；置信度上限受此限制',
      mixed: '一部分依据是用户的原话，一部分是模型的推断；置信度按「含推断」的上限计算',
    };

    /**
     * The basis chip for one entry or evidence row.
     * @param statement - `user`, `assistant`, or `mixed`.
     * @returns the chip element.
     */
    function basisChip(statement, manual = false) {
      const key = BASIS_LABEL[statement] === undefined ? 'user' : statement;
      // A hand-set confidence is the user's own judgement, so the ceiling the basis
      // would impose no longer applies and the hover must not claim it does.
      const title = manual ? `${BASIS_TITLE[key]}；手动设置置信度时不受此限` : BASIS_TITLE[key];
      return h(Chip, { tone: BASIS_TONE[key], title }, BASIS_LABEL[key]);
    }

    /**
     * Say what a refresh actually returned.
     *
     * A silent re-read looks broken when nothing changed, so the outcome names the
     * counts and the profile timestamp, and reports the delta when there is one.
     *
     * @param before - the previous snapshot, when there was one.
     * @param after - the snapshot just read.
     * @returns one status line.
     */
    function describeRefresh(before, after) {
      const countActive = (snapshot) => {
        let total = 0;
        for (const list of Object.values(snapshot?.profile?.dimensions ?? {})) {
          if (!Array.isArray(list)) continue;
          for (const entry of list) if (entry?.status === 'active') total += 1;
        }
        return total;
      };
      const now = countActive(after);
      const parts = [`已刷新 ${when(Date.now())}`, `${now} 条生效`, `画像更新于 ${when(after?.profile?.updatedAt)}`];
      if (before !== undefined) {
        const delta = now - countActive(before);
        const profileChanged = (before?.profile?.updatedAt ?? 0) !== (after?.profile?.updatedAt ?? 0);
        if (delta !== 0) parts.push(`条目 ${delta > 0 ? '+' : ''}${delta}`);
        else if (!profileChanged) parts.push('内容无变化');
        else parts.push('画像已更新');
      }
      return parts.join(' · ');
    }

    /**
     * A tinted status bar with an optional progress meter.
     * @param props - tone, text, and 0-1 progress.
     * @returns the status element.
     */
    function StatusBar({ tone, text, progress }) {
      return h(
        'div',
        { className: 'dup-status', 'data-tone': tone, role: 'status', 'aria-live': 'polite' },
        progress === undefined
          ? null
          : h('span', { className: 'dup-progress' }, h('span', { style: { width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` } })),
        h('span', { className: 'dup-status-text' }, text),
      );
    }

    /** The portrait panel. */
    function PortraitPanel(props) {
      const openSettings = props?.openSettings;
      const seatFailures = Array.isArray(props?.seatFailures) ? props.seatFailures : [];
      const [state, setState] = React.useState({ status: 'loading' });
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [view, setView] = React.useState('dimensions');
      const [query, setQuery] = React.useState('');
      const [drafts, setDrafts] = React.useState({});
      const [adding, setAdding] = React.useState({ open: false, dimension: 'skill', text: '' });
      const [noteDraft, setNoteDraft] = React.useState('');
      const [noteOpen, setNoteOpen] = React.useState(false);
      // The 废弃 area is collapsed by default: it is a holding pen, not the point
      // of the panel, but it must be one click away at all times.
      const [discardOpen, setDiscardOpen] = React.useState(false);
      // When the last successful re-read happened, so a manual refresh has visible
      // evidence of doing anything at all.
      const [refreshedAt, setRefreshedAt] = React.useState(undefined);
      // Ticks once when the finished-backfill banner is due to disappear, so the
      // panel re-renders without it (the panel has no polling loop to lean on).
      const [, setBannerTick] = React.useState(0);
      const [refreshing, setRefreshing] = React.useState(false);
      /** Handle of the 2-second re-read armed while a backfill run is active. */
      const backfillWatchRef = React.useRef(undefined);
      /** The profile version currently on screen, so pushes can be de-duplicated. */
      const seenVersionRef = React.useRef(0);
      /** The entry whose permanent deletion is waiting for a second click. */
      const [purgeArmed, setPurgeArmed] = React.useState(undefined);
      /**
       * The same value as a ref.
       *
       * The decision "is this the second click?" must not depend on which render's
       * closure the button carries: a stale closure would silently re-arm instead of
       * deleting, and a deletion that quietly does nothing is worse than none.
       */
      const purgeArmedRef = React.useRef(undefined);
      /** 废弃区「清空」的二次确认状态（一次点击只武装，不删除）。 */
      const [discardClearArmed, setDiscardClearArmed] = React.useState(false);
      /** 哪张结论卡片展开了编辑菜单（一次只开一张）。 */
      const [menuFor, setMenuFor] = React.useState(undefined);
      const discardClearArmedRef = React.useRef(false);
      /** 结论上限 dialog: open flag plus the numbers being edited. */
      const [capOpen, setCapOpen] = React.useState(false);
      const [capDraft, setCapDraft] = React.useState(undefined);
      /** 导出 dialog: open flag plus which optional fields to include. */
      const [exportOpen, setExportOpen] = React.useState(false);
      const [exportFields, setExportFields] = React.useState({ note: false, confidence: false, basis: false, updated: false, source: false });
      /** 时间线清理：预览结果与弹窗开关。 */
      const [timelineOpen, setTimelineOpen] = React.useState(false);
      const [timelineStats, setTimelineStats] = React.useState(undefined);
      const tabRefs = React.useRef({});
      const tabListRef = React.useRef(null);
      const indicatorRef = React.useRef(null);

      const load = React.useCallback(async () => {
        try {
          const payload = await call({ query: { view: 'snapshot' } });
          seenVersionRef.current = Math.max(seenVersionRef.current, payload?.profile?.updatedAt ?? 0);
          setState((current) => ({ status: 'ready', data: payload, previous: current.status === 'ready' ? current.data : undefined }));
          setRefreshedAt(Date.now());
          // While a backfill / redigest run is in progress, keep re-reading every two
          // seconds. Nothing else announces session-by-session progress or the moment
          // the run ends, so without this the panel freezes on its first numbers. The
          // watch ends with the run: once `active` is false, no further read is armed.
          if (payload?.progress?.backfill?.active === true) {
            if (backfillWatchRef.current !== undefined) window.clearTimeout(backfillWatchRef.current);
            backfillWatchRef.current = window.setTimeout(() => {
              backfillWatchRef.current = undefined;
              void load();
            }, 2000);
          }
          reportToHost('snapshot', {
            ok: true,
            dimensions: Array.isArray(payload?.dimensions) ? payload.dimensions.length : -1,
            groups: Array.isArray(payload?.groups) ? payload.groups.length : -1,
            entries: Object.values(payload?.profile?.dimensions ?? {}).reduce(
              (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
              0,
            ),
          });
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A failed re-read must not throw away a panel that already has data:
          // report it and keep showing the last good snapshot.
          setState((current) => (current.status === 'ready' ? current : { status: 'error', message }));
          setNotice({ tone: 'error', text: `读取失败：${message}` });
          reportToHost('snapshot', { ok: false, error: message });
          return false;
        }
      }, []);

      // Initial read, then a change stream.
      //
      // The panel used to poll the whole snapshot every 20 seconds just to notice a
      // new conclusion — expensive and noisy. The Host now pushes one event per
      // profile write over `?view=stream`, so the panel refreshes exactly when
      // something changed and stays completely silent otherwise.
      React.useEffect(() => {
        let alive = true;
        void (async () => {
          try {
            const payload = await call({ query: { view: 'snapshot' } });
            if (!alive) return;
            seenVersionRef.current = Math.max(seenVersionRef.current, payload?.profile?.updatedAt ?? 0);
            setState({ status: 'ready', data: payload });
          } catch (error) {
            if (alive) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
          }
        })();

        let stream;
        if (typeof window.EventSource === 'function') {
          try {
            stream = new window.EventSource(`${new URL(ENDPOINT, window.location.origin).href}?view=stream`);
            const onUpdate = (event) => {
              let info;
              try {
                info = JSON.parse(event.data);
              } catch {
                return;
              }
              const updatedAt = Number(info?.updatedAt ?? 0);
              if (updatedAt <= 0 || updatedAt === seenVersionRef.current) return;
              seenVersionRef.current = updatedAt;
              if (alive) void load();
            };
            // `hello` is the handshake after a (re)connect: if the profile moved
            // while the stream was down, catch up once.
            stream.addEventListener('hello', onUpdate);
            stream.addEventListener('profile', onUpdate);
            // Errors are the EventSource's own business: it reconnects on its own,
            // and a dead stream must not turn into a polling loop.
            stream.onerror = () => undefined;
          } catch {
            stream = undefined;
          }
        }
        return () => {
          alive = false;
          stream?.close?.();
        };
      }, [load]);

      // The panel is mounted inside the pane: this is the report that proves the
      // seat dispatched the body, and it records the snapshot shape the renderer
      // actually received.
      React.useEffect(() => {
        reportToHost('mounted', {
          inSettings: openSettings === undefined,
          seatFailures: seatFailures.length,
        });
      }, []);

      // A permanent delete waits for a second click, but not forever: arming
      // expires on its own so a stray click cannot be completed later by accident.
      React.useEffect(() => {
        if (purgeArmed === undefined) return undefined;
        const timer = window.setTimeout(() => {
          purgeArmedRef.current = undefined;
          setPurgeArmed(undefined);
        }, 5000);
        return () => window.clearTimeout(timer);
      }, [purgeArmed]);

      // Same five-second window for the 废弃 area's bulk delete.
      React.useEffect(() => {
        if (discardClearArmed !== true) return undefined;
        const timer = window.setTimeout(() => {
          discardClearArmedRef.current = false;
          setDiscardClearArmed(false);
        }, 5000);
        return () => window.clearTimeout(timer);
      }, [discardClearArmed]);

      // After the run ends, the finished result stays on screen for a short window and
      // then removes itself. The countdown starts at `finishedAt`, i.e. when the run
      // completed — never at the moment it was started. Watching a running job is
      // scheduled from `load()` instead, because that is where the payload that says
      // "still running" arrives.
      React.useEffect(() => {
        const info = state.status === 'ready' ? state.data?.progress?.backfill ?? {} : {};
        const finishedAt = Number(info.finishedAt ?? 0);
        if (info.active === true || finishedAt <= 0) return undefined;
        const remaining = BACKFILL_BANNER_MS - (Date.now() - finishedAt);
        if (remaining <= 0) return undefined;
        const timer = window.setTimeout(() => setBannerTick((value) => value + 1), remaining + 100);
        return () => window.clearTimeout(timer);
      }, [state]);

      // Keep the segmented indicator under the active tab. This must stay ABOVE
      // the loading/error early returns: a hook reached on only some render paths
      // changes the hook count between renders, which React rejects outright
      // (error #310) and which blanked the whole pane.
      React.useEffect(() => {
        const list = tabListRef.current;
        const target = tabRefs.current[view];
        const indicator = indicatorRef.current;
        if (list === null || target === null || target === undefined || indicator === null || indicator === undefined) return;
        // Real CSS geometry moves the indicator; a non-layout environment (the
        // test harness) falls back to an equal fifth of the track.
        const width = typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect().width : 0;
        indicator.style.width = width > 0 ? `${width}px` : 'calc((100% - 8px) / 5)';
        indicator.style.transform = `translateX(${target.offsetLeft ?? 4}px)`;
      }, [view, state]);

      /**
       * Two-step permanent deletion for the 废弃 area.
       *
       * The first click only arms it (and shows how to cancel: just wait); the
       * second one deletes for good. Nothing about this is recoverable, which is why
       * it lives here instead of on the dimension cards.
       *
       * @param entry - the entry to delete permanently.
       */
      const confirmPurge = React.useCallback(
        async (entry) => {
          if (purgeArmedRef.current !== entry.id) {
            purgeArmedRef.current = entry.id;
            setPurgeArmed(entry.id);
            setNotice({ tone: 'warning', text: '再次点击「确认删除？」将永久删除，无法恢复（5 秒后自动取消）' });
            return;
          }
          purgeArmedRef.current = undefined;
          setPurgeArmed(undefined);
          setBusy(true);
          setNotice(null);
          try {
            const reply = await call({
              body: { action: 'update', op: 'purgeEntry', id: entry.id, matchText: entry.text },
            });
            await load();
            const removed = Number(reply?.removedEvidence ?? 0);
            const shared = Number(reply?.sharedEvidence ?? 0);
            setNotice({
              tone: 'success',
              text:
                `已永久删除「${String(entry.text).slice(0, 18)}」` +
                (removed > 0 ? `，同时移除 ${removed} 条只属于它的证据` : '') +
                (shared > 0 ? `（${shared} 处证据仍被其它结论引用，已保留）` : ''),
            });
          } catch (error) {
            setNotice({ tone: 'error', text: `删除失败：${error instanceof Error ? error.message : String(error)}` });
          } finally {
            setBusy(false);
          }
        },
        [purgeArmed, load],
      );

      /**
       * Two-step permanent clear for the whole 废弃 area.
       *
       * Every non-active conclusion is deleted for good, with the evidence that
       * exists for it alone, so the first click only arms the action.
       *
       * @param total - how many conclusions the caller saw, for the warning text.
       */
      const confirmClearDiscard = React.useCallback(
        async (total) => {
          if (discardClearArmedRef.current !== true) {
            discardClearArmedRef.current = true;
            setDiscardClearArmed(true);
            setNotice({
              tone: 'warning',
              text: `再次点击「确认清空？」将永久删除全部 ${total} 条废弃结论，无法恢复（5 秒后自动取消）`,
            });
            return;
          }
          discardClearArmedRef.current = false;
          setDiscardClearArmed(false);
          setBusy(true);
          setNotice(null);
          try {
            const reply = await call({ body: { action: 'update', op: 'clearDiscard' } });
            await load();
            setNotice({
              tone: 'success',
              text: `已清空废弃区：永久删除 ${Number(reply?.removed ?? 0)} 条结论（连同只属于它们的证据）`,
            });
          } catch (error) {
            setNotice({ tone: 'error', text: `清空失败：${error instanceof Error ? error.message : String(error)}` });
          } finally {
            setBusy(false);
          }
        },
        [load],
      );

      /**
       * Ask the Host what a timeline cleanup would remove, then show the preview.
       *
       * Nothing is deleted until the dialog's confirm button is pressed: the plan is
       * a dry run, and the numbers come from the Host so they match what would really
       * happen.
       */
      const previewTimeline = React.useCallback(async () => {
        setBusy(true);
        setNotice(null);
        try {
          const reply = await call({ body: { action: 'maintain', op: 'timelinePlan' } });
          setTimelineStats(reply?.stats);
          setTimelineOpen(true);
        } catch (error) {
          setNotice({ tone: 'error', text: `无法计算清理方案：${error instanceof Error ? error.message : String(error)}` });
        } finally {
          setBusy(false);
        }
      }, []);

      const run = React.useCallback(
        async (body, successMessage, successTone) => {
          setBusy(true);
          setNotice(null);
          try {
            await call({ body });
            await load();
            if (successMessage !== undefined) setNotice({ tone: successTone ?? 'success', text: successMessage });
          } catch (error) {
            setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
          } finally {
            setBusy(false);
          }
        },
        [load],
      );

      /**
       * Re-read the panel from disk and say what came back.
       *
       * The previous version called `load()` silently, and because the Host serves
       * an identical snapshot when nothing has changed, the button produced no
       * visible effect at all. The result is now reported explicitly, including
       * what changed since the previous snapshot.
       */
      const refreshNow = React.useCallback(async () => {
        setRefreshing(true);
        setNotice(null);
        const before = state.status === 'ready' ? state.data : undefined;
        try {
          const payload = await call({ query: { view: 'snapshot' } });
          setState((current) => ({ status: 'ready', data: payload, previous: current.status === 'ready' ? current.data : undefined }));
          setRefreshedAt(Date.now());
          setNotice({ tone: 'success', text: describeRefresh(before, payload) });
        } catch (error) {
          setNotice({ tone: 'error', text: `刷新失败：${error instanceof Error ? error.message : String(error)}` });
        } finally {
          setRefreshing(false);
        }
      }, [state]);

      if (state.status === 'loading') {
        return h(
          'div',
          { className: 'dup-root' },
          h(
            'div',
            { className: 'dup-body' },
            ...[0, 1, 2].map((index) => h('div', { key: index, className: 'dup-skeleton' })),
          ),
        );
      }
      if (state.status === 'error') {
        return h(
          'div',
          { className: 'dup-root' },
          h(
            'div',
            { className: 'dup-head' },
            h('div', { className: 'dup-title-row' }, h('div', { className: 'dup-title' }, h('span', { className: 'dup-dot' }), '人物画像')),
          ),
          h(
            'div',
            { className: 'dup-body' },
            h(StatusBar, { tone: 'error', text: `读取失败：${state.message}` }),
            h('div', { className: 'dup-row' }, h(Button, { variant: 'outline', iconName: 'refresh', label: '重试', onClick: () => load() })),
          ),
        );
      }

      const data = state.data;
      const dimensions = Array.isArray(data.dimensions) && data.dimensions.length > 0 ? data.dimensions : FALLBACK_DIMENSIONS;
      const groups = Array.isArray(data.groups) && data.groups.length > 0 ? data.groups : FALLBACK_GROUPS;
      const feedbackUrl = typeof data.feedbackUrl === 'string' ? data.feedbackUrl.trim() : '';
      const caps = data.caps ?? { mode: 'total', total: 50, daily: 20, tech: 30, usage: { total: 0, daily: 0, tech: 0, manual: 0 } };
      const capUsage = caps.usage ?? { total: 0, daily: 0, tech: 0, manual: 0 };
      const blacklist = data.blacklist ?? { count: 0, updatedAt: 0 };
      // The cap that actually applies is the larger of the two spellings: a unified
      // total, or the daily+technical groups added up. Setting one mode narrower
      // than the other must not silently lower the ceiling.
      const groupCap = (caps.daily ?? 0) + (caps.tech ?? 0);
      const effectiveCap = Math.max(caps.total ?? 0, groupCap, caps.effective ?? 0);
      // Everything the 结论上限 button used to spell out under itself now lives in
      // its hover text: the counts, the manual exclusion, and where the number comes
      // from.
      const capLabel = [
        caps.mode === 'group'
          ? `当前上限：日常 ${capUsage.daily}/${caps.daily} · 技术 ${capUsage.tech}/${caps.tech}（手动结论不计入）`
          : `当前上限：${capUsage.total}/${effectiveCap} 条（手动结论不计入）`,
        `统一 ${caps.total} · 分组 ${caps.daily}+${caps.tech}=${groupCap}（取较大者 ${effectiveCap} 条）`,
        `手动新增不受上限阻挡，当前另有 ${capUsage.manual} 条手动结论`,
      ].join('\n');
      const capReached =
        caps.mode === 'group'
          ? capUsage.daily >= caps.daily || capUsage.tech >= caps.tech
          : capUsage.total >= effectiveCap;
      const profile = data.profile ?? { dimensions: {}, notes: [] };
      const notes = profile.notes ?? [];
      // The 刷新 hover carries what the meta line under the title used to show, so
      // the panel is quieter without losing the information.
      const refreshTitle = [
        `更新于 ${when(profile.updatedAt)}`,
        `数据目录 ${data.dataDir ?? '—'}`,
        `已刷新 ${refreshedAt === undefined ? '—' : when(refreshedAt)}`,
        '点击重新从磁盘读取画像与进度，并显示刷新结果',
      ].join('\n');
      const progress = data.progress ?? {};
      const backfill = progress.backfill ?? {};
      // "正在进行" while it runs; the result only for a short window afterwards, so
      // a finished backfill does not sit on the panel forever.
      const backfillFinishedAt = Number(backfill.finishedAt ?? 0);
      const backfillBanner =
        backfill.active === true
          ? h(StatusBar, {
              tone: 'info',
              text: `历史回填进行中：${backfill.done ?? 0}/${backfill.total ?? 0}`,
              progress: (backfill.total ?? 0) > 0 ? (backfill.done ?? 0) / backfill.total : undefined,
            })
          : backfillFinishedAt > 0 && Date.now() - backfillFinishedAt < BACKFILL_BANNER_MS
            ? h(StatusBar, { tone: 'success', text: `历史回填已完成：${backfill.done ?? 0}/${backfill.total ?? 0}` })
            : null;
      let activeTotal = 0;
      for (const dimension of dimensions) {
        for (const entry of profile.dimensions?.[dimension.id] ?? []) {
          if (entry.status === 'active') activeTotal += 1;
        }
      }
      const covered = dimensions.filter((dimension) =>
        (profile.dimensions?.[dimension.id] ?? []).some((entry) => entry.status === 'active'),
      ).length;

      const header = h(
        'div',
        { className: 'dup-head' },
        h(
          'div',
          { className: 'dup-title-row' },
          h('div', { className: 'dup-title' }, h('span', { className: 'dup-dot' }), '人物画像'),
          openSettings === undefined
            ? null
            : h(Button, {
                variant: 'icon',
                iconName: 'settings',
                title: '在设置中打开',
                onClick: () => openSettings(),
              }),
        ),
        h(
          'div',
          { className: 'dup-meta' },
          `${activeTotal} 条生效结论 · 覆盖 ${covered}/${dimensions.length} 个维度 · 逐轮摘要 ${progress.digests ?? 0} 个会话 · 证据 ${progress.evidence ?? 0} 条`,
        ),
        backfillBanner,
        notice === null && busy !== true ? null : h(StatusBar, {
          tone: notice === null ? 'info' : notice.tone,
          text: notice === null ? '正在与 Host 同步…' : notice.text,
        }),
        seatFailures.length === 0 ? null : h(StatusBar, {
          tone: 'warning',
          text: `有 ${seatFailures.length} 处入口注册失败：${seatFailures.join('；')}`,
        }),
        h(
          'div',
          { className: 'dup-toolbar' },
          h(Button, {
            variant: 'primary',
            iconName: 'sparkle',
            label: '立即重新提炼',
            // The three maintenance entries look similar and behave differently; each
            // one explains itself on hover so nobody has to guess which one re-reads
            // sessions.
            title: [
              '立即重新提炼（不重读会话）',
              '· 只用已经提炼出来的证据：上次合并之后新增的；没有新增时取最近 40 条',
              '· 不重新摘要会话，只把现有证据重新合并进画像',
              '· 遵守结论上限：超限时先并入同维度最相近的一条，相关度不足 0.5 才拒绝',
              '· 黑名单中的证据不参与合并',
              '· 证据不足时本次不合并，面板会说明原因',
            ].join('\n'),
            disabled: busy,
            onClick: () => run({ action: 'maintain', op: 'synthesizeNow' }, '已重新合并画像'),
          }),
          h(Button, {
            variant: 'outline',
            iconName: 'refresh',
            label: '回填全部历史会话',
            title: [
              '回填全部历史会话（只补没提炼过的）',
              '· 只处理尚未提炼的会话，子代理会话一律跳过',
              '· 每个会话取最近 24 轮，重新做逐轮摘要并写入证据',
              '· 已处理过、或上次读取失败的会话不会重复处理；要重跑请用右侧「重新提炼全部历史」',
              '· 跑完自动合并一次，并遵守结论上限',
              '· 黑名单中的证据照样被排除',
            ].join('\n'),
            disabled: busy,
            onClick: () => run({ action: 'maintain', op: 'backfill' }, '已开始回填未处理的会话'),
          }),
          h(Button, {
            variant: 'outline',
            iconName: 'archive',
            label: '重新提炼全部历史',
            title: [
              '重新提炼全部历史（重跑，不是重建画像）',
              '· 忽略“已处理”标记与进度水位，重新摘要所有会话',
              '· 证据按内容去重：已存在的行不会重复写入',
              '· 现有结论不会被清空，仍按合并规则叠加；黑名单中的证据照样被排除',
              '· 跑完自动合并一次，并遵守结论上限',
              '· 会话多时需要一段时间，进度条会显示 x/y',
            ].join('\n'),
            disabled: busy,
            onClick: () => run({ action: 'maintain', op: 'redigest' }, '已开始重新提炼全部历史会话'),
          }),
          h(Button, {
            variant: 'outline',
            iconName: 'refresh',
            // A refresh that only re-reads the same data looks broken. The label
            // says what is happening, the outcome is reported explicitly, and the
            // stamp/data-directory details live in the hover text instead of a
            // permanent line under the title.
            label: refreshing ? '刷新中…' : '刷新',
            title: refreshTitle,
            disabled: busy || refreshing,
            onClick: () => void refreshNow(),
          }),
          h(Button, {
            variant: 'outline',
            iconName: 'sparkle',
            label: '反馈与建议',
            // Stays disabled until `feedbackUrl` is configured: a button that opens
            // a page nobody chose would be worse than one that says it is not set.
            title: feedbackUrl === '' ? '未设置反馈网址（配置项 feedbackUrl）' : `打开 ${feedbackUrl}`,
            disabled: feedbackUrl === '',
            onClick: () => {
              if (feedbackUrl === '') return;
              window.open(feedbackUrl, '_blank', 'noopener,noreferrer');
            },
          }),
        ),
      );

      const TAB_ITEMS = [
        ['dimensions', '画像维度'],
        ['notes', '我的备注'],
        ['sessions', '会话记录'],
        ['timeline', '证据时间线'],
      ];
      const tabs = h(
        'div',
        { className: 'dup-tabs', role: 'tablist', 'aria-label': '人物画像视图', ref: tabListRef },
        h('span', { className: 'dup-tab-indicator', 'aria-hidden': 'true', ref: indicatorRef }),
        ...TAB_ITEMS.map(([id, label]) =>
          h(
            'button',
            {
              key: id,
              type: 'button',
              role: 'tab',
              className: 'dup-tab',
              'data-active': view === id,
              'aria-selected': view === id,
              ref: (node) => {
                tabRefs.current[id] = node;
              },
              onClick: () => setView(id),
            },
            label,
          ),
        ),
      );

      const body = h('div', { className: 'dup-body' }, renderView());

      return h('div', { className: 'dup-root' }, header, tabs, body, renderDialogs());

      /**
       * The 导出 and 结论上限 overlays.
       *
       * Both are mounted once at the root and gated by their own flag, so opening
       * one cannot change the number of hooks the body renders.
       */
      function renderDialogs() {
        const dialogs = [];
        if (capOpen) {
          const draft = capDraft ?? { mode: caps.mode, total: caps.total, daily: caps.daily, tech: caps.tech, charLimit: caps.charLimit };
          const field = (key, label) =>
            h(
              'label',
              { className: 'dup-cap-field' },
              label,
              h('input', {
                type: 'number',
                min: 0,
                step: 1,
                value: draft[key],
                'data-cap-field': key,
                onChange: (event) =>
                  setCapDraft((current) => ({ ...(current ?? draft), [key]: Math.max(0, Math.floor(Number(event.target.value) || 0)) })),
              }),
            );
          dialogs.push(
            h(
              'div',
              { key: 'cap-dialog', className: 'dup-overlay', 'data-dialog': 'cap' },
              h(
                'div',
                { className: 'dup-dialog' },
                h('div', { className: 'dup-dialog-title' }, '结论上限'),
                h(
                  'div',
                  { className: 'dup-dialog-hint' },
                  '上限只管自动提炼出的结论；手动新增的结论不计入，也不会因为超限被并入或删除。达到上限后，新结论先按相关度并入同一维度里最相近的一条，相关度不足 0.5 则拒绝并入并提示你删减。',
                ),
                h(
                  'div',
                  { className: 'dup-row' },
                  h(Button, {
                    variant: draft.mode === 'total' ? 'primary' : 'outline',
                    label: '统一上限',
                    onClick: () => setCapDraft({ ...draft, mode: 'total' }),
                  }),
                  h(Button, {
                    variant: draft.mode === 'group' ? 'primary' : 'outline',
                    label: '分组上限',
                    onClick: () => setCapDraft({ ...draft, mode: 'group' }),
                  }),
                ),
                draft.mode === 'group'
                  ? h('div', { className: 'dup-cap-grid' }, field('daily', '日常画像上限'), field('tech', '技术画像上限'))
                  : h('div', { className: 'dup-cap-grid' }, field('total', '全画像合计上限')),
                h(
                  'div',
                  { className: 'dup-cap-grid' },
                  h(
                    'label',
                    { className: 'dup-cap-field' },
                    '每条结论字数上限（1–500）',
                    h('input', {
                      type: 'number',
                      min: 1,
                      max: 500,
                      step: 1,
                      value: draft.charLimit ?? caps.charLimit ?? 50,
                      'data-cap-field': 'charLimit',
                      onChange: (event) => {
                        const next = Math.floor(Number(event.target.value) || 0);
                        setCapDraft((current) => ({ ...(current ?? draft), charLimit: Math.min(500, Math.max(1, next)) }));
                      },
                    }),
                  ),
                ),
                h(
                  'div',
                  { className: 'dup-dialog-hint' },
                  '字数上限自动结论与手动新增共用同一值；只影响之后生成或编辑的结论，已有条目不追溯截断。',
                ),
                h(
                  'div',
                  { className: 'dup-cap-usage', 'data-over': capReached },
                  `当前已用：自动 ${capUsage.total} 条（日常 ${capUsage.daily} · 技术 ${capUsage.tech}），手动 ${capUsage.manual} 条不计入`,
                ),
                h(
                  'div',
                  { className: 'dup-field-row' },
                  h(Button, {
                    variant: 'primary',
                    label: '保存上限',
                    disabled: busy,
                    onClick: async () => {
                      await run({ action: 'update', op: 'setEntryCap', cap: draft }, '已更新结论上限');
                      setCapOpen(false);
                    },
                  }),
                  h(Button, { variant: 'ghost', label: '取消', onClick: () => setCapOpen(false) }),
                ),
              ),
            ),
          );
        }
        if (exportOpen) {
          const option = (key, label) =>
            h(
              'label',
              { className: 'dup-option' },
              h('input', {
                type: 'checkbox',
                checked: exportFields[key] === true,
                'data-export-field': key,
                onChange: (event) => setExportFields((current) => ({ ...current, [key]: event.target.checked })),
              }),
              label,
            );
          dialogs.push(
            h(
              'div',
              { key: 'export-dialog', className: 'dup-overlay', 'data-dialog': 'export' },
              h(
                'div',
                { className: 'dup-dialog' },
                h('div', { className: 'dup-dialog-title' }, '导出为 Markdown'),
                h('div', { className: 'dup-dialog-hint' }, '画像维度、维度描述与生效结论始终包含；下面五项按需勾选。'),
                h('div', { className: 'dup-option', 'data-locked': 'true' }, h('input', { type: 'checkbox', checked: true, disabled: true }), '画像维度 + 维度描述 + 结论（始终）'),
                option('note', '备注'),
                option('confidence', '置信度'),
                option('basis', '依据'),
                option('updated', '修改时间'),
                option('source', '来源'),
                h(
                  'div',
                  { className: 'dup-field-row' },
                  h(Button, {
                    variant: 'primary',
                    label: '导出',
                    onClick: () => {
                      downloadPortrait(exportFields);
                      setExportOpen(false);
                    },
                  }),
                  h(Button, { variant: 'ghost', label: '取消', onClick: () => setExportOpen(false) }),
                ),
              ),
            ),
          );
        }
        if (timelineOpen) {
          const stats = timelineStats ?? {};
          dialogs.push(
            h(
              'div',
              { key: 'timeline-dialog', className: 'dup-overlay', 'data-dialog': 'timeline' },
              h(
                'div',
                { className: 'dup-dialog' },
                h('div', { className: 'dup-dialog-title' }, '清理时间线'),
                h(
                  'div',
                  { className: 'dup-dialog-hint' },
                  `账本共 ${stats.rows ?? 0} 条证据、${stats.turns ?? 0} 轮。未被任何结论引用的轮整轮删除；被引用的轮最多保留 ${stats.perTurn ?? 2} 条，优先保留支撑结论的那条。`,
                ),
                h(
                  'div',
                  { className: 'dup-cap-usage', 'data-over': (stats.removedRows ?? 0) > 0 },
                  `将删除 ${stats.removedRows ?? 0} 条（来自 ${stats.removedTurns ?? 0} 个未引用的轮 + 每轮超出部分），保留 ${stats.keptRows ?? 0} 条。`,
                ),
                h(
                  'div',
                  { className: 'dup-dialog-hint' },
                  '删除前会自动备份账本（evidence.jsonl.before-timeline-compaction），并写一条 deleted.log。',
                ),
                h(
                  'div',
                  { className: 'dup-field-row' },
                  h(Button, {
                    variant: 'primary',
                    label: (stats.removedRows ?? 0) > 0 ? '确认清理' : '没有可清理的证据',
                    disabled: busy || (stats.removedRows ?? 0) === 0,
                    onClick: async () => {
                      await run({ action: 'maintain', op: 'compactTimeline' }, `已清理时间线：删除 ${stats.removedRows ?? 0} 条`);
                      setTimelineOpen(false);
                    },
                  }),
                  h(Button, { variant: 'ghost', label: '取消', onClick: () => setTimelineOpen(false) }),
                ),
              ),
            ),
          );
        }
        return dialogs;
      }

      /**
       * Build the Markdown and hand it to the browser as a download.
       * @param fields - which optional details to include.
       */
      function downloadPortrait(fields) {
        const markdown = buildPortraitMarkdown({ groups, dimensions, profile, fields, now: Date.now() });
        const stamp = new Date().toISOString().slice(0, 10);
        try {
          const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `user-portrait-${stamp}.md`;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 4000);
          setNotice({ tone: 'success', text: `已导出 user-portrait-${stamp}.md（${markdown.length} 字符）` });
        } catch (error) {
          setNotice({ tone: 'error', text: `导出失败：${error instanceof Error ? error.message : String(error)}` });
        }
      }

      /** Render the active tab's content. */
      function renderView() {
        if (view === 'dimensions') return renderDimensions();
        if (view === 'timeline') return renderTimeline();
        if (view === 'sessions') return renderSessions();
        return renderNotes();
      }

      /**
       * The 我的备注 block, rendered as its own tab group.
       *
       * It used to be pinned above the dimensions as well, which duplicated the
       * same list in two places; the tab is now the only home for notes.
       */
      function renderNotesSection() {
        const open = noteOpen;
        const cards = notes.map((note, index) =>
          h(
            'div',
            { key: `${note.at}-${index}`, className: 'dup-entry', 'data-kind': 'note' },
            h('div', { className: 'dup-entry-text' }, note.text),
            h(
              'div',
              { className: 'dup-entry-actions' },
              h('span', { className: 'dup-src', style: { marginTop: '0' } }, when(note.at)),
              h('span', { style: { flex: '1' } }),
              h('button', {
                type: 'button',
                className: 'dup-mini',
                'data-variant': 'danger',
                disabled: busy,
                onClick: () => void run({ action: 'update', op: 'removeNote', at: note.at }, '已删除备注'),
              }, '删除'),
            ),
          ),
        );
        return h(
          'div',
          { className: 'dup-group' },
          h(
            'div',
            { className: 'dup-group-head' },
            h('span', { className: 'dup-group-name' }, '我的备注'),
            h('span', { className: 'dup-group-total' }, `${notes.length} 条`),
            h(
              'span',
              { style: { marginLeft: 'auto', flex: 'none' } },
              h(Button, {
                variant: 'ghost',
                iconName: open ? 'chevronUp' : 'plus',
                label: open ? '收起' : '添加备注',
                onClick: () => setNoteOpen(!open),
              }),
            ),
          ),
          h('div', { className: 'dup-group-hint' }, '备注的优先级高于任何自动结论：下一次提炼时会被强制保留。'),
          notes.length === 0 ? h('div', { className: 'dup-empty' }, '暂无备注。') : null,
          ...cards,
          open
            ? h(
                'div',
                { className: 'dup-entry' },
                h('textarea', {
                  className: 'dup-textarea',
                  placeholder: '例如「我在做 XX 项目，别再建议 YY 方案」',
                  value: noteDraft,
                  onChange: (event) => setNoteDraft(event.target.value),
                }),
                h(
                  'div',
                  { className: 'dup-field-row' },
                  h(Button, {
                    variant: 'primary',
                    label: '保存备注',
                    disabled: busy || noteDraft.trim() === '',
                    onClick: async () => {
                      await run({ action: 'update', op: 'addNote', text: noteDraft }, '已添加备注');
                      setNoteDraft('');
                      setNoteOpen(false);
                    },
                  }),
                  h(Button, { variant: 'ghost', label: '取消', onClick: () => setNoteOpen(false) }),
                ),
              )
            : null,
        );
      }

      function renderDimensions() {
        const blocks = [];
        // 检索 is pinned at the top of this view: it filters the conclusions that
        // are already loaded, so it needs no round trip and cannot fail silently.
        blocks.push(renderSearchBlock());
        blocks.push(
          h(
            'div',
            { key: 'add-form', className: 'dup-section' },
            h(
              'div',
              { className: 'dup-row' },
              h(Button, {
                variant: adding.open ? 'ghost' : 'outline',
                iconName: adding.open ? 'close' : 'plus',
                label: adding.open ? '取消新增' : '手动新增条目',
                onClick: () => setAdding((current) => ({ ...current, open: !current.open })),
              }),
              h(Button, {
                variant: 'outline',
                iconName: 'settings',
                label: '结论上限',
                // The hover text is the whole point here: it shows the current
                // budget and why the visible count can exceed it.
                title: capLabel,
                'data-cap-mode': caps.mode,
                onClick: () => {
                  setCapDraft({ mode: caps.mode, total: caps.total, daily: caps.daily, tech: caps.tech, charLimit: caps.charLimit });
                  setCapOpen(true);
                },
              }),
              h(Button, {
                variant: 'outline',
                iconName: 'archive',
                label: '导出',
                title: '把画像维度导出为 Markdown 文档',
                onClick: () => setExportOpen(true),
              }),
            ),
            // The budget warning sits with the buttons that manage it, so "达到上限"
            // never looks like a rendering glitch.
            capReached
              ? h(StatusBar, {
                  tone: 'warning',
                  text:
                    caps.mode === 'group'
                      ? `结论已达上限（日常 ${capUsage.daily}/${caps.daily}、技术 ${capUsage.tech}/${caps.tech}）：新结论会先并入最相近的已有结论，相关度不足 0.5 时会被拒绝，请删减后重新提炼。`
                      : `结论已达上限（${capUsage.total}/${effectiveCap}）：新结论会先并入最相近的已有结论，相关度不足 0.5 时会被拒绝，请删减后重新提炼。`,
                })
              : null,
            adding.open
              ? h(
                  'div',
                  { className: 'dup-entry' },
                  h(
                    'div',
                    { className: 'dup-row' },
                    h(
                      'select',
                      {
                        className: 'dup-select',
                        value: adding.dimension,
                        onChange: (event) => setAdding((current) => ({ ...current, dimension: event.target.value })),
                      },
                      ...groups.flatMap((group) =>
                        dimensions
                          .filter((dimension) => dimension.group === group.id)
                          .map((dimension) => h('option', { key: dimension.id, value: dimension.id }, `${group.label} · ${dimension.label}`)),
                      ),
                    ),
                  ),
                  h('textarea', {
                    className: 'dup-textarea',
                    placeholder: '一条关于你自己的结论，例如「更看重可维护性而不是最快跑通」',
                    value: adding.text,
                    onChange: (event) => setAdding((current) => ({ ...current, text: event.target.value })),
                  }),
                  h(
                    'div',
                    { className: 'dup-field-row' },
                    h(Button, {
                      variant: 'primary',
                      label: '保存',
                      disabled: busy || adding.text.trim() === '',
                      onClick: async () => {
                        await run({ action: 'update', op: 'addEntry', dimension: adding.dimension, text: adding.text }, '已新增');
                        setAdding({ open: false, dimension: adding.dimension, text: '' });
                      },
                    }),
                    h(Button, { variant: 'ghost', label: '取消', onClick: () => setAdding((current) => ({ ...current, open: false })) }),
                  ),
                )
              : null,
          ),
        );
        for (const group of groups) {
          const members = dimensions.filter((dimension) => dimension.group === group.id);
          if (members.length === 0) continue;
          const groupTotal = members.reduce(
            (sum, dimension) => sum + (profile.dimensions?.[dimension.id] ?? []).filter((entry) => entry.status === 'active').length,
            0,
          );
          blocks.push(
            h(
              'div',
              { key: group.id, className: 'dup-group' },
              h(
                'div',
                { className: 'dup-group-head' },
                h('span', { className: 'dup-group-name' }, group.label),
                h('span', { className: 'dup-group-total' }, `${groupTotal} 条生效`),
              ),
              group.hint === undefined ? null : h('div', { className: 'dup-group-hint' }, group.hint),
              ...members.map((dimension) => renderDimension(dimension)),
            ),
          );
        }
        // 废弃 belongs at the very bottom: it is a holding pen, and the page should
        // read as the live portrait first.
        blocks.push(renderDiscardSection(!discardOpen));
        return blocks;
      }

      function renderDimension(dimension) {
        const entries = profile.dimensions?.[dimension.id] ?? [];
        // Only live conclusions live in the dimension card; retired and superseded
        // rows are collected in the 废弃 area instead, so a dimension reads as
        // what is currently believed.
        const active = entries.filter((entry) => entry.status === 'active');
        return h(
          'div',
          { key: dimension.id, className: 'dup-section' },
          h(
            'div',
            { className: 'dup-section-head' },
            h('span', { className: 'dup-section-name' }, dimension.label),
            h(
              'span',
              { className: 'dup-section-count', title: dimension.hint },
              `${active.length} 条生效`,
            ),
          ),
          dimension.hint === undefined ? null : h('div', { className: 'dup-group-hint' }, dimension.hint),
          active.length === 0 ? h('div', { className: 'dup-empty' }, '暂无证据') : null,
          ...active.map((entry) => renderEntry(entry)),
        );
      }

      /**
       * Every non-active conclusion, grouped by dimension.
       *
       * This is the panel's 废弃 area: retired, superseded and deleted conclusions
       * with the same card framework as the dimensions, so they can be inspected
       * and restored instead of vanishing.
       */
      function renderDiscardSection(collapsed) {
        const withEntries = dimensions
          .map((dimension) => ({
            dimension,
            entries: (profile.dimensions?.[dimension.id] ?? []).filter((entry) => entry.status !== 'active'),
          }))
          .filter((bucket) => bucket.entries.length > 0);
        const total = withEntries.reduce((sum, bucket) => sum + bucket.entries.length, 0);
        /**
         * The one-click purge for the whole holding pen.
         *
         * Permanent, so it arms on the first click like the single-entry delete and
         * asks with a different label; it stays hidden while the pen is empty.
         */
        const clearButton =
          total === 0
            ? null
            : h(Button, {
                variant: 'ghost',
                iconName: 'trash',
                label: discardClearArmed ? '确认清空？' : '清空',
                'data-confirm': discardClearArmed ? 'true' : undefined,
                title: discardClearArmed
                  ? '再点一次即永久删除全部废弃结论，无法恢复'
                  : `永久删除全部 ${total} 条废弃结论（连同只属于它们的证据，不可恢复）`,
                disabled: busy,
                onClick: () => void confirmClearDiscard(total),
              });
        if (collapsed) {
          return h(
            'div',
            { key: 'discard-collapsed', className: 'dup-section', 'data-section': 'discard' },
            h(
              'div',
              { className: 'dup-section-head' },
              h('span', { className: 'dup-section-name' }, '废弃'),
              h('span', { className: 'dup-section-count' }, `${total} 条`),
              h(
                'span',
                { style: { flex: 'none', display: 'flex', gap: '4px' } },
                clearButton,
                h(Button, {
                  variant: 'ghost',
                  iconName: 'chevronUp',
                  label: '展开',
                  onClick: () => setDiscardOpen(true),
                }),
              ),
            ),
            h('div', { className: 'dup-group-hint' }, '已废弃 / 已取代 / 已删除的结论，可随时恢复。'),
          );
        }
        return h(
          'div',
          { key: 'discard', className: 'dup-group', 'data-section': 'discard' },
          h(
            'div',
            { className: 'dup-group-head' },
            h('span', { className: 'dup-group-name' }, '废弃'),
            h('span', { className: 'dup-group-total' }, `${total} 条`),
            h(
              'span',
              { style: { marginLeft: 'auto', flex: 'none', display: 'flex', gap: '4px' } },
              clearButton,
              h(Button, {
                variant: 'ghost',
                iconName: 'chevronUp',
                label: '收起',
                onClick: () => setDiscardOpen(false),
              }),
            ),
          ),
          h(
            'div',
            { className: 'dup-group-hint' },
            '这里安放已废弃 / 已取代 / 已删除的结论：它们不再计入画像，相关证据同时被移出提炼（黑名单），点「恢复」即可回到对应维度并重新计入。',
          ),
          total === 0 ? h('div', { className: 'dup-empty' }, '暂无废弃结论。') : null,
          ...withEntries.map((bucket) =>
            h(
              'div',
              { key: `discard-${bucket.dimension.id}`, className: 'dup-section' },
              h(
                'div',
                { className: 'dup-section-head' },
                h('span', { className: 'dup-section-name' }, bucket.dimension.label),
                h(
                  'span',
                  { className: 'dup-section-count' },
                  `${bucket.entries.length} 条废弃`,
                ),
              ),
              ...bucket.entries.map((entry) => renderEntry(entry, { purge: true })),
            ),
          ),
        );
      }

      /**
       * One conclusion card.
       *
       * @param entry - the entry.
       * @param options - `purge` when the card is inside the 废弃 area, where
       *   "delete" means permanent removal rather than a move.
       */
      function renderEntry(entry, options = {}) {
        const draft = drafts[entry.id];
        const editing = draft !== undefined;
        const manual = entry.manual === true;
        const purge = options.purge === true;
        return h(
          'div',
          // Always explicit, so every card carries a deterministic state and a
          // reader (or a test) never has to infer "active" from an absent field.
          // `data-kind` separates a conclusion card from a note card, which shares
          // the same visual shell.
          // `data-entry-id` is the anchor the 检索 results jump to.
          { key: entry.id, className: 'dup-entry', 'data-kind': 'conclusion', 'data-entry-id': entry.id, 'data-status': entry.status ?? 'active' },
          editing
            ? h('textarea', {
                className: 'dup-textarea',
                value: draft,
                onChange: (event) => setDrafts((current) => ({ ...current, [entry.id]: event.target.value })),
              })
            : h('div', { className: 'dup-entry-text' }, entry.text),
          h(
            'div',
            { className: 'dup-entry-foot' },
            // One 编辑 control, left of the confidence chip, opens the menu with every
            // per-conclusion action. Five always-visible buttons per row made a long
            // list of conclusions read as a control panel instead of a portrait.
            h(
              'button',
              {
                type: 'button',
                className: 'dup-edit-chip',
                'data-action': 'edit',
                'data-open': menuFor === entry.id ? 'true' : undefined,
                disabled: busy,
                title: '编辑这条结论：改文字、调置信度、废弃或删除',
                onClick: () => setMenuFor((current) => (current === entry.id ? undefined : entry.id)),
              },
              '编辑',
            ),
            h(
              Chip,
              {
                tone: CONFIDENCE_TONE[entry.confidence] ?? 'quiet',
                title: manual ? '置信度（手动设置，不受依据上限限制）' : '置信度',
              },
              `置信度 ${CONFIDENCE_LABEL[entry.confidence] ?? entry.confidence}`,
            ),
            // The first-seen stamp lives in this chip's hover instead of a permanent
            // line: it is reference detail, not something to read every time.
            h(
              Chip,
              { tone: entry.status === 'active' ? 'neutral' : 'outline', title: `首次 ${when(entry.firstSeenAt)}` },
              STATUS_LABEL[entry.status] ?? entry.status,
            ),
            // A row that was deleted (rather than merely retired by synthesis) says
            // so, which is how the 废弃 area stays legible.
            entry.deletedAt === undefined ? null : h(Chip, { tone: 'outline', title: `于 ${when(entry.deletedAt)} 删除` }, '删除'),
            basisChip(entry.statement, manual),
            // The count sits right after 依据 rather than on a line of its own: it is
            // the same fact (where this conclusion comes from), so it reads as one.
            (entry.sources ?? []).length === 0
              ? null
              : h(
                  'span',
                  { className: 'dup-src-count', tabIndex: 0, title: sourceTooltip(entry), 'data-inline': 'source' },
                  `来源 ${(entry.sources ?? []).length} 处`,
                ),
            manual ? h(Chip, { tone: 'info' }, '手动') : null,
          ),
          entry.note === undefined || entry.note === '' ? null : h('div', { className: 'dup-src' }, `备注: ${entry.note}`),
          menuFor === entry.id && !editing
            ? h(
                'div',
                { className: 'dup-entry-menu', 'data-menu': entry.id },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dup-mini',
                    disabled: busy,
                    onClick: () => {
                      setDrafts((current) => ({ ...current, [entry.id]: entry.text }));
                      setMenuFor(undefined);
                    },
                  },
                  '编辑文字',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dup-mini',
                    'data-variant': 'confidence',
                    disabled: busy || entry.confidence === 'high',
                    title: '提高这条结论的置信度',
                    onClick: () => {
                      setMenuFor(undefined);
                      void run(
                        { action: 'update', op: 'setConfidence', id: entry.id, matchText: entry.text, confidence: nextConfidence(entry.confidence, 'up') },
                        '已提高置信度',
                      );
                    },
                  },
                  entry.confidence === 'high' ? '已最高' : `升为${CONFIDENCE_LABEL[nextConfidence(entry.confidence, 'up')]}`,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dup-mini',
                    'data-variant': 'confidence',
                    disabled: busy || entry.confidence === 'low',
                    title: '降低这条结论的置信度',
                    onClick: () => {
                      setMenuFor(undefined);
                      void run(
                        { action: 'update', op: 'setConfidence', id: entry.id, matchText: entry.text, confidence: nextConfidence(entry.confidence, 'down') },
                        '已降低置信度',
                      );
                    },
                  },
                  entry.confidence === 'low' ? '已最低' : `降为${CONFIDENCE_LABEL[nextConfidence(entry.confidence, 'down')]}`,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dup-mini',
                    disabled: busy,
                    title: entry.status === 'active' ? '移入「废弃」区，可随时恢复' : '恢复到原维度',
                    onClick: () => {
                      setMenuFor(undefined);
                      void run(
                        { action: 'update', op: 'setStatus', id: entry.id, matchText: entry.text, status: entry.status === 'active' ? 'retired' : 'active' },
                        entry.status === 'active' ? '已移入废弃区' : '已恢复',
                      );
                    },
                  },
                  entry.status === 'active' ? '废弃' : '恢复',
                ),
                purge
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dup-mini',
                        'data-variant': 'danger',
                        disabled: busy,
                        'data-confirm': purgeArmed === entry.id ? 'true' : undefined,
                        title:
                          purgeArmed === entry.id
                            ? '再点一次即永久删除，无法恢复'
                            : '永久删除这条结论（连同只属于它的证据，不可恢复）',
                        onClick: () => {
                          setMenuFor(undefined);
                          void confirmPurge(entry);
                        },
                      },
                      purgeArmed === entry.id ? '确认删除？' : '永久删除',
                    )
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'dup-mini',
                        'data-variant': 'danger',
                        disabled: busy,
                        // Inside a dimension this only moves the conclusion to 废弃.
                        title: '移入「废弃」区（可恢复；要永久删除请到废弃区操作）',
                        onClick: () => {
                          setMenuFor(undefined);
                          void run({ action: 'update', op: 'removeEntry', id: entry.id, matchText: entry.text }, '已移入废弃区');
                        },
                      },
                      '删除',
                    ),
              )
            : null,
          // While editing, only the save/cancel pair remains: the menu is closed.
          editing
            ? h(
                'div',
                { className: 'dup-entry-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dup-mini',
                    'data-variant': 'keep',
                    disabled: busy,
                    onClick: async () => {
                      await run({ action: 'update', op: 'updateEntry', id: entry.id, matchText: entry.text, text: drafts[entry.id] }, '已保存修改');
                      setDrafts((current) => {
                        const next = { ...current };
                        delete next[entry.id];
                        return next;
                      });
                    },
                  },
                  '保存',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dup-mini',
                    'data-variant': 'keep',
                    onClick: () =>
                      setDrafts((current) => {
                        const next = { ...current };
                        delete next[entry.id];
                        return next;
                      }),
                  },
                  '取消',
                ),
              )
            : null,
        );
      }

      function renderTimeline() {
        const rows = data.evidence ?? [];
        // The blacklist is reported here because this is the view it affects: rows
        // removed with a permanently deleted conclusion never come back into the
        // timeline or the next extraction, until the list is cleared.
        const blacklistBar =
          blacklist.count > 0
            ? h(
                'div',
                { key: 'blacklist', className: 'dup-row', 'data-section': 'blacklist' },
                h(Chip, { tone: 'outline' }, `已屏蔽 ${blacklist.count} 条证据 · ${blacklist.turns ?? 0} 轮`),
                h(Button, {
                  variant: 'ghost',
                  iconName: 'refresh',
                  label: '清空黑名单',
                  // The explanation sits on the action that reverses it, instead of
                  // taking a permanent line in the timeline header.
                  title: [
                    '因结论被物理删除；重新提炼时不计入。',
                    '· 清空后这些证据可以重新参与提炼',
                    '· 仍在废弃区的结论，其证据会在下一次校准时重新进入黑名单（废弃即屏蔽）',
                    '· 物理删除留下的屏蔽不会自动回来：那是不可逆操作',
                  ].join('\n'),
                  disabled: busy,
                  onClick: () => run({ action: 'update', op: 'clearBlacklist' }, '已清空黑名单'),
                }),
                h(Button, {
                  variant: 'ghost',
                  iconName: 'trash',
                  label: '清理时间线',
                  title: [
                    '清理时间线（先预览，再删除）',
                    '· 同一会话同一轮归为一组（覆盖来源相同）',
                    '· 没有被任何结论引用的轮：整轮删除',
                    '· 被结论引用的轮：最多保留 2 条，优先保留支撑结论的那条',
                    '· 删除前自动备份账本，并写一条 deleted.log',
                  ].join('\n'),
                  disabled: busy,
                  onClick: () => void previewTimeline(),
                }),
              )
            : null;
        // A re-run leaves a ready-made cleanup preview behind; surface the number so
        // the cleanup is discoverable without opening the dialog first.
        const planHint =
          Number(progress.timelinePlan?.removedRows ?? 0) > 0
            ? h(
                'div',
                { key: 'plan', className: 'dup-group-hint' },
                `本次重跑后可清理 ${progress.timelinePlan.removedRows} 条无用证据（点「清理时间线」查看明细）`,
              )
            : null;
        if (rows.length === 0) {
          return blacklistBar === null && planHint === null ? h('div', { className: 'dup-empty' }, '还没有证据记录。') : [blacklistBar, planHint];
        }
        return [
          blacklistBar,
          planHint,
          h('div', { key: 'hint', className: 'dup-meta' }, `最近 ${rows.length} 条证据（新→旧）`),
          ...rows.map((row, index) =>
            h(
              'div',
              { key: `${row.key ?? index}`, className: 'dup-entry' },
              h('div', { className: 'dup-entry-text' }, row.text),
              h(
                'div',
                { className: 'dup-entry-foot' },
                h(Chip, { tone: 'outline' }, row.kind === 'preference' ? '偏好/纠正' : row.dimension ?? '—'),
                basisChip(row.statement),
                h(Chip, { tone: CONFIDENCE_TONE[row.confidence] ?? 'quiet' }, CONFIDENCE_LABEL[row.confidence] ?? row.confidence ?? '—'),
                h(
                  'span',
                  {
                    className: 'dup-src-count',
                    tabIndex: 0,
                    title: `出处：${row.sessionId ?? '—'}${row.turn === undefined ? '' : ` · 第 ${row.turn} 轮`} · ${when(row.at)}${
                      row.source === undefined || row.source === '' ? '' : `\n    原文：${row.source}`
                    }`,
                  },
                  `${row.sessionId ?? '—'}${row.turn === undefined ? '' : `#T${row.turn}`} · ${when(row.at)}`,
                ),
              ),
            ),
          ),
        ];
      }

      function renderSessions() {
        const sessions = data.sessions ?? [];
        if (sessions.length === 0) return h('div', { className: 'dup-empty' }, '还没有会话记录。');
        return sessions.map((session) =>
          h(
            'div',
            { key: session.sessionId, className: 'dup-section' },
            h(
              'div',
              { className: 'dup-section-head' },
              h('span', { className: 'dup-section-name' }, session.rollup?.topic === undefined || session.rollup.topic === '' ? session.sessionId : session.rollup.topic),
              h('span', { className: 'dup-section-count' }, `${session.turnCount ?? 0} 轮 · ${when(session.updatedAt ?? session.createdAt)}`),
            ),
            session.rollup?.overview === undefined || session.rollup.overview === ''
              ? null
              : h('div', { className: 'dup-pre' }, session.rollup.overview),
            ...(session.turns ?? []).map((turn) =>
              h(
                'div',
                { key: `${session.sessionId}-${turn.turn}`, className: 'dup-turn' },
                h('div', { className: 'dup-turn-q' }, `T${turn.turn} 我问：${turn.userAsk ?? '（未记录）'}`),
                (turn.userKeyPoints ?? []).length === 0
                  ? null
                  : h('div', { className: 'dup-turn-a' }, `要点：${turn.userKeyPoints.join('；')}`),
                h('div', { className: 'dup-turn-a' }, `你答：${turn.assistantSummary ?? '（未记录）'}`),
                (turn.corrections ?? []).length === 0
                  ? null
                  : h('div', { className: 'dup-turn-a' }, `纠正：${turn.corrections.map((item) => item.text).join('；')}`),
              ),
            ),
          ),
        );
      }

      /**
       * The pinned 检索 block at the top of 画像维度.
       *
       * It searches the PROFILE CONCLUSIONS that are already in memory, so it is a
       * live filter rather than a round trip: every keystroke narrows the list,
       * there is nothing to wait for, and there is no failure mode. The previous
       * design posted to the Host and threw the reply away, so pressing 检索
       * produced nothing at all.
       *
       * Matches keep the conclusion's context (dimension, confidence, basis and
       * source count), and clicking one jumps to that entry in the list below.
       *
       * @returns the search block.
       */
      function renderSearchBlock() {
        const needle = query.trim().toLowerCase();
        const hits = needle === '' ? [] : matchProfile(profile, dimensions, needle);
        return h(
          'div',
          { key: 'search', className: 'dup-section', 'data-section': 'search' },
          h(
            'div',
            { className: 'dup-section-head' },
            h('span', { className: 'dup-section-name' }, '检索'),
            h(
              'span',
              { className: 'dup-section-count' },
              needle === '' ? '输入关键词，即时筛选画像结论' : `${hits.length} 条命中`,
            ),
          ),
          h(
            'div',
            { className: 'dup-row' },
            h('input', {
              className: 'dup-input',
              style: { flex: '1', minWidth: '160px' },
              placeholder: '在画像结论中检索（维度、结论文本）',
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            query === ''
              ? null
              : h(Button, { variant: 'ghost', label: '清空', onClick: () => setQuery('') }),
          ),
          needle === ''
            ? null
            : h(
                'div',
                { className: 'dup-group-hint' },
                hits.length === 0
                  ? '没有命中的结论。换个词试试，或清空关键词回到完整画像。'
                  : '点击结果可定位到下方对应条目。',
              ),
          ...hits.map((hit) =>
            h(
              'div',
              {
                key: `hit-${hit.entry.id}`,
                className: 'dup-entry',
                'data-kind': 'search-hit',
                'data-status': hit.entry.status ?? 'active',
                role: 'button',
                tabIndex: 0,
                title: '定位到该条目',
                onClick: () => revealEntry(hit.entry),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') revealEntry(hit.entry);
                },
              },
              h('div', { className: 'dup-entry-text' }, highlight(hit.entry.text, needle)),
              h(
                'div',
                { className: 'dup-entry-foot' },
                h(Chip, { tone: 'outline' }, hit.dimensionLabel),
                h(Chip, { tone: CONFIDENCE_TONE[hit.entry.confidence] ?? 'quiet' }, `置信度 ${CONFIDENCE_LABEL[hit.entry.confidence] ?? hit.entry.confidence}`),
                basisChip(hit.entry.statement),
                hit.entry.status === 'active' ? null : h(Chip, { tone: 'outline' }, STATUS_LABEL[hit.entry.status] ?? hit.entry.status),
                h('span', {}, (hit.entry.sources ?? []).length === 0 ? '无来源记录' : `来源 ${(hit.entry.sources ?? []).length} 处`),
              ),
            ),
          ),
        );
      }

      /**
       * Jump to one entry in the list below, opening the 废弃 area first when the
       * entry lives there.
       * @param entry - the entry to reveal.
       */
      function revealEntry(entry) {
        if (entry.status !== 'active' && !discardOpen) setDiscardOpen(true);
        // A DOM lookup after paint is reliable here: the panel owns its own subtree
        // and the entry carries a stable data attribute.
        setTimeout(() => {
          const node = document.querySelector(`[data-entry-id="${entry.id}"]`);
          node?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        }, 0);
      }

      function renderNotes() {
        return renderNotesSection();
      }
    }

    /**
     * Find the profile conclusions matching a query.
     *
     * Only conclusions are searched — never the evidence ledger or the per-turn
     * records: the panel's question is "what does the portrait believe about X",
     * and mixing raw records into that answer made the list unreadable.
     *
     * @param profile - the profile document from the Host.
     * @param needle - the lower-cased query.
     * @returns hits with the dimension they belong to, active entries first.
     */
    function matchProfile(profile, dimensions, needle) {
      const hits = [];
      for (const dimension of dimensions) {
        const entries = profile?.dimensions?.[dimension.id] ?? [];
        for (const entry of entries) {
          if (typeof entry.text !== 'string') continue;
          const haystack = `${entry.text} ${dimension.label} ${entry.note ?? ''}`.toLowerCase();
          if (!haystack.includes(needle)) continue;
          hits.push({ dimensionLabel: dimension.label, entry });
        }
      }
      hits.sort((left, right) => {
        const activeLeft = left.entry.status === 'active' ? 0 : 1;
        const activeRight = right.entry.status === 'active' ? 0 : 1;
        return activeLeft - activeRight;
      });
      return hits;
    }

    /**
     * Render a text with every occurrence of the query marked.
     * @param text - the conclusion text.
     * @param needle - the lower-cased query.
     * @returns text nodes with `<mark>` around each hit.
     */
    function highlight(text, needle) {
      if (needle === '') return text;
      const lower = text.toLowerCase();
      const parts = [];
      let cursor = 0;
      let at = lower.indexOf(needle);
      let guard = 0;
      while (at !== -1 && guard < 20) {
        guard += 1;
        if (at > cursor) parts.push(text.slice(cursor, at));
        parts.push(h('mark', { key: `m${at}`, className: 'dup-mark' }, text.slice(at, at + needle.length)));
        cursor = at + needle.length;
        at = lower.indexOf(needle, cursor);
      }
      if (cursor < text.length) parts.push(text.slice(cursor));
      return parts.length === 0 ? text : parts;
    }

    /**
     * Catch a rendering failure inside the panel and show it.
     *
     * Without this, a throw anywhere under the pane is answered by the seat
     * service isolating the entry — the user sees an empty pane and nothing is
     * written to any log, which is the least debuggable outcome possible. A
     * class component is required: only an error boundary can catch a child's
     * render throw.
     */
    class PortraitBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: undefined };
      }

      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }

      componentDidCatch(error) {
        console.error('user portrait: the panel failed to render', error);
      }

      render() {
        if (this.state.error !== undefined) {
          return h(
            'div',
            { className: 'dup-root' },
            h(
              'div',
              { className: 'dup-head' },
              h('div', { className: 'dup-title-row' }, h('div', { className: 'dup-title' }, h('span', { className: 'dup-dot' }), '人物画像')),
            ),
            h(
              'div',
              { className: 'dup-body' },
              h(StatusBar, { tone: 'error', text: `面板渲染失败：${this.state.error}` }),
              h(
                'div',
                { className: 'dup-row' },
                h(Button, {
                  variant: 'outline',
                  iconName: 'refresh',
                  label: '重新挂载',
                  onClick: () => this.setState({ error: undefined }),
                }),
              ),
              h('div', { className: 'dup-group-hint' }, '把这条报错发给维护者即可定位；面板其余部分不受影响。'),
            ),
          );
        }
        return this.props.children;
      }
    }

    /** The settings page wrapper: the same panel, plus a way back. */
    function PortraitSettingsSection(props) {
      const close = props?.close;
      const openSettings = React.useCallback(() => {
        // Already inside Settings: nothing to navigate to.
        close?.();
      }, [close]);
      return h(PortraitPanel, { openSettings: undefined, seatFailures: props?.seatFailures });
    }

    /** The header button that reveals the panel. */
    function PortraitHeaderAction(props) {
      const open = props?.openPortrait;
      return h(
        'button',
        {
          type: 'button',
          className: 'dup-btn',
          'data-variant': 'outline',
          title: '打开人物画像面板',
          'aria-label': '打开人物画像面板',
          onClick: () => open?.(),
        },
        glyph('user'),
        h('span', {}, '画像'),
      );
    }

    /**
     * The composer's portrait switch, sitting next to the permission selector.
     *
     * Per session, persisted by the Host: the master switch decides whether the
     * portrait is injected into this conversation's prompt at all, and the two group
     * switches choose which half is mentioned. Default is OFF.
     *
     * @param props - `sessionId` injected by the composer slot.
     */
    function PortraitModeControl(props) {
      const sessionId = String(props?.sessionId ?? '');
      const [mode, setMode] = React.useState(undefined);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      React.useEffect(() => {
        if (sessionId === '') return undefined;
        let alive = true;
        void call({ query: { view: 'sessionMode', session: sessionId } })
          .then((payload) => {
            if (alive) setMode(payload?.mode);
          })
          .catch(() => undefined);
        return () => {
          alive = false;
        };
      }, [sessionId]);
      const current = mode ?? { enabled: false, daily: true, tech: true };
      const toggle = React.useCallback(
        async (patch) => {
          if (sessionId === '' || busy) return;
          const next = { ...current, ...patch };
          setMode(next);
          setBusy(true);
          try {
            const reply = await call({ body: { action: 'update', op: 'setSessionMode', session: sessionId, ...patch } });
            if (reply?.mode !== undefined) setMode(reply.mode);
          } catch {
            setMode(current);
          } finally {
            setBusy(false);
          }
        },
        [sessionId, busy, current],
      );
      const row = (key, label, hint) =>
        h(
          'div',
          { className: 'dup-mode-row' },
          h(
            'span',
            { className: 'dup-mode-label' },
            h('span', { className: 'dup-mode-name' }, label),
            h('span', { className: 'dup-mode-hint' }, hint),
          ),
          h('button', {
            type: 'button',
            className: 'dup-mode-switch',
            role: 'switch',
            'aria-checked': current[key] === true,
            'data-on': current[key] === true,
            'data-key': key,
            disabled: busy || (key !== 'enabled' && current.enabled !== true),
            title: hint,
            onClick: () => void toggle({ [key]: current[key] !== true }),
          }),
        );
      return h(
        'div',
        { className: 'dup-mode' },
        h(
          'button',
          {
            type: 'button',
            className: 'dup-mode-trigger',
            'data-on': current.enabled === true,
            title: '把画像作为本会话的参考（点击展开开关）',
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
          },
          h('span', { className: 'dup-mode-dot', 'data-on': current.enabled === true }),
          '画像',
        ),
        open
          ? h(
              'div',
              { className: 'dup-mode-pop', 'data-pop': 'portrait-mode' },
              row('enabled', '启用画像', '把画像作为本会话参考'),
              row('daily', '日常画像', '只注入日常部分'),
              row('tech', '技术画像', '只注入技术部分'),
              h('div', { className: 'dup-mode-foot' }, '默认关闭 · 只影响本会话的提示词'),
            )
          : null,
      );
    }

    /**
     * The registry instance this page load already registered the tab type with,
     * if any.
     *
     * The registry rejects a second registration of the same id outright, and a
     * reload (or a second evaluation of this half) can reach here again while the
     * type is still registered from the previous run. Remembering the instance
     * makes that path idempotent without hiding a real failure: a DIFFERENT
     * registry — a fresh context, as in a test or a rebuilt service — is
     * registered with normally.
     */
    let tabTypeRegistry = undefined;
    /** Disposer for this page load's tab type registration, when one was given. */
    let tabTypeDisposer = undefined;

    /**
     * Report whether a thrown value is the registry saying "this id already
     * exists".
     *
     * That is not a failure of this plugin: the desired end state — the type
     * being registered — is already true, and the leftover entry (from an earlier
     * run whose disposal never ran) is the reason. Treating it as an error only
     * produced a standing warning in the panel.
     *
     * @param error - the thrown value.
     * @returns true when the registry reports a duplicate id.
     */
    function isAlreadyRegistered(error) {
      const message = error instanceof Error ? error.message : String(error);
      return /already registered/i.test(message);
    }

    /**
     * Render the portrait as the Markdown a 导出 produces.
     *
     * The dimensions, their hints and the conclusions themselves are always
     * included; `fields` only toggles the five extra details. Only `active`
     * conclusions are exported — a discarded or superseded row is history, not the
     * current portrait.
     *
     * @param input - `{ groups, dimensions, profile, fields, now }`.
     * @returns the Markdown text.
     */
    function buildPortraitMarkdown(input) {
      const groups = Array.isArray(input?.groups) ? input.groups : [];
      const dimensions = Array.isArray(input?.dimensions) ? input.dimensions : [];
      const profile = input?.profile ?? { dimensions: {} };
      const fields = input?.fields ?? {};
      const now = typeof input?.now === 'number' ? input.now : Date.now();
      const when = (ms) => {
        const value = Number(ms);
        if (!Number.isFinite(value) || value <= 0) return '未知';
        return new Date(value).toLocaleString('zh-CN', { hour12: false });
      };
      let active = 0;
      let manual = 0;
      for (const dimension of dimensions) {
        for (const entry of profile.dimensions?.[dimension.id] ?? []) {
          if (entry.status !== 'active') continue;
          active += 1;
          if (entry.manual === true) manual += 1;
        }
      }

      const lines = ['# 人物画像', ''];
      lines.push(`> 导出时间：${when(now)} · 生效结论 ${active} 条（其中手动 ${manual} 条，不计入上限）`, '');

      for (const group of groups) {
        const members = dimensions.filter((dimension) => dimension.group === group.id);
        const groupLines = [];
        for (const dimension of members) {
          const entries = (profile.dimensions?.[dimension.id] ?? []).filter((entry) => entry.status === 'active');
          if (entries.length === 0) continue;
          groupLines.push(`### ${dimension.label}`);
          if (typeof dimension.hint === 'string' && dimension.hint !== '') groupLines.push('', `> ${dimension.hint}`);
          groupLines.push('');
          entries.forEach((entry, index) => {
            groupLines.push(`${index + 1}. ${entry.text}` + (entry.manual === true ? '（手动）' : ''));
            if (fields.note === true && typeof entry.note === 'string' && entry.note !== '') {
              groupLines.push(`   - 备注：${entry.note}`);
            }
            if (fields.confidence === true) {
              groupLines.push(`   - 置信度：${CONFIDENCE_LABEL[entry.confidence] ?? entry.confidence ?? '未知'}`);
            }
            if (fields.basis === true) {
              const basis = BASIS_LABEL[entry.statement] ?? {};
              groupLines.push(`   - 依据：${basis.text ?? entry.statement ?? '未知'}`);
            }
            if (fields.updated === true) {
              groupLines.push(`   - 修改时间：${when(entry.lastConfirmedAt ?? entry.firstSeenAt)}`);
            }
            if (fields.source === true) {
              const sources = Array.isArray(entry.sources) ? entry.sources : [];
              groupLines.push(
                `   - 来源：${sources.length === 0 ? '（无）' : sources.map((source) => `${String(source.sessionId ?? '').slice(0, 8)}…#T${source.turn ?? '?'}`).join('、')}`,
              );
            }
          });
          groupLines.push('');
        }
        if (groupLines.length > 0) {
          lines.push(`## ${group.label}`, '', ...groupLines);
        }
      }
      return `${lines.join('\n').trimEnd()}\n`;
    }

    return {
      inject: ['slots'],
      /**
       * Exposed for the offline checks: the Markdown a 导出 would produce.
       *
       * Pure and DOM-free on purpose — the browser wiring around it (Blob, anchor)
       * is the only part that needs a document.
       */
      buildPortraitMarkdown,
      apply(ctx) {
        const slots = ctx.slots ?? ctx.get('slots');
        if (slots === undefined || typeof slots.inject !== 'function') {
          console.error('user portrait: the slot service is unavailable; the panel cannot register');
          return;
        }
        installStylesheet();
        ctx.effect(
          () => () => {
            removeStylesheet();
          },
          'user-portrait.styles',
        );

        const openPanel = () => {
          const sidebarRight = ctx.get('sidebarRight');
          const layout = ctx.get('layout');
          try {
            sidebarRight?.openTab?.(TAB_KIND);
          } catch (error) {
            console.error('user portrait: could not open the portrait tab', error);
          }
          layout?.openRightbar?.(false, false);
        };
        const openSettings = () => {
          const layout = ctx.get('layout');
          try {
            layout?.selectPanel?.('settings');
          } catch (error) {
            console.error('user portrait: could not open settings', error);
          }
        };

        /**
         * Contribute one slot seat without endangering the others.
         *
         * Every contribution runs in its own try/catch: a seat this build cannot
         * reach (an older registry, a renamed seat, a duplicate key) must cost
         * that one contribution, never the rest of the panel. The failures are
         * collected and surfaced inside the pane instead of vanishing — the seat
         * service isolates a throwing entry, which otherwise shows up as a
         * completely blank pane with nothing in any log.
         */
        const failures = [];
        const contributedSeats = [];
        const contribute = (label, contribute) => {
          try {
            contribute();
            contributedSeats.push(label);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(`${label}: ${message}`);
            console.error(`user portrait: ${label} failed`, error);
          }
        };

        // The right sidebar's tab registry is PROVIDED by another plugin, and a
        // plugin that declares no dependencies activates before that provider has
        // run: `ctx.get('sidebarRightTabs')` is still undefined at this point.
        // Registering the tab type later is therefore mandatory — without it the
        // type never exists, the pane shows the host's "unknown type" fallback,
        // and the panel looks blank even though its body registered fine. (This
        // is exactly what the client self-report caught: tabsService
        // "unavailable" alongside body-registered "ok".)
        const registerTabType = () => {
          const tabs = ctx.get('sidebarRightTabs');
          if (tabs === undefined || typeof tabs.register !== 'function') {
            return { state: 'pending' };
          }
          if (tabTypeRegistry === tabs) return { state: 'registered', reused: true };
          if (typeof tabTypeDisposer === 'function') {
            // A previous run's entry is still live (its disposal never ran, as
            // after a reload): drop it and register this run's own entry, so the
            // registry's cleanup stays paired with a living fiber.
            try {
              tabTypeDisposer();
            } catch {
              // A stale disposer that throws is not worth failing the panel over.
            }
            tabTypeDisposer = undefined;
          }
          try {
            const dispose = tabs.register({
              id: PLUGIN_ID,
              kind: TAB_KIND,
              priority: 'extension',
              title: () => '画像',
            });
            tabTypeRegistry = tabs;
            if (typeof dispose === 'function') tabTypeDisposer = dispose;
            // The registration is owned by this plugin's effect, so unloading the
            // plugin removes the type instead of leaving it for the next run to
            // collide with.
            ctx.effect(
              () => () => {
                if (typeof dispose === 'function') dispose();
                tabTypeDisposer = undefined;
              },
              'user-portrait.tab-type',
            );
            return { state: 'registered' };
          } catch (error) {
            if (isAlreadyRegistered(error)) {
              // The type is already there — the state this plugin wants. Keep the
              // latch so this run does not try again.
              tabTypeRegistry = tabs;
              return { state: 'registered', existing: true };
            }
            throw error;
          }
        };

        const firstAttempt = (() => {
          try {
            return registerTabType();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(`页签类型: ${message}`);
            return { state: 'failed', message };
          }
        })();

        if (firstAttempt.state === 'registered') {
          contributedSeats.push('页签类型');
        } else if (firstAttempt.state === 'pending') {
          // Wait for the provider. Bounded so a profile without the right
          // sidebar cannot retry forever, and owned by this plugin's effect so a
          // reload stops the wait instead of leaving a timer behind.
          let attempts = 0;
          let timer;
          const stop = () => {
            if (timer !== undefined) window.clearInterval(timer);
            timer = undefined;
          };
          ctx.effect(() => stop, 'user-portrait.tab-type-wait');
          timer = window.setInterval(() => {
            attempts += 1;
            try {
              if (registerTabType().state === 'registered') {
                stop();
                contributedSeats.push('页签类型');
                // A distinct stage: the one-shot report set already carries the
                // first, still-pending `tab-type` line.
                reportToHost('tab-type-late', {
                  tabsService: 'ok',
                  attempts: attempts + 1,
                  typeId: PLUGIN_ID,
                  kind: TAB_KIND,
                });
                return;
              }
            } catch (error) {
              stop();
              const message = error instanceof Error ? error.message : String(error);
              failures.push(`页签类型: ${message}`);
              reportToHost('tab-type-late', { tabsService: 'ok', attempts: attempts + 1, outcome: message });
              return;
            }
            if (attempts >= 40) {
              stop();
              failures.push('右栏页签注册表始终未提供（sidebarRightTabs）');
              reportToHost('tab-type-late', { tabsService: 'unavailable', attempts, outcome: 'gave up waiting' });
            }
          }, 500);
        }

        reportToHost('tab-type', {
          tabsService: firstAttempt.state === 'registered' ? 'ok' : firstAttempt.state,
          attempts: 1,
          typeId: PLUGIN_ID,
          kind: TAB_KIND,
          failures,
        });

        // The body is registered even when the tab type could not be: the two are
        // separate seats, and a body without its type is still reachable through
        // the Settings page.
        //
        // The key must be the tab type's ID, not its kind. The pane seat
        // dispatches a tab's body with `entryKey: definition?.id ?? tab.kind`, so
        // a body keyed by the kind is never found and the pane shows only its
        // "unavailable" fallback — a blank-looking panel with a working chip.
        contribute('面板内容体', () => {
          slots.inject('sidebar.right.pane.tab', () => {
            // `slots.inject` hands this callback to an effect, so it runs only
            // once the seat is DECLARED — and if the seat never appears it never
            // runs at all. Reporting from inside here is what separates "the
            // registration call was accepted" from "the body actually landed".
            reportToHost('seat-declared', { seat: 'sidebar.right.pane.tab', key: PLUGIN_ID });
            let outcome = 'ok';
            let dispose;
            try {
              dispose = slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: PLUGIN_ID,
                  inject: () => ({ onOpenSettings: openSettings, onSeatFailures: failures }),
                },
                (slotProps) =>
                  h(
                    PortraitBoundary,
                    {},
                    h(PortraitPanel, {
                      openSettings: slotProps?.onOpenSettings,
                      seatFailures: slotProps?.onSeatFailures,
                    }),
                  ),
              );
            } catch (error) {
              outcome = error instanceof Error ? error.message : String(error);
              failures.push(`面板内容体注册: ${outcome}`);
            }
            reportToHost('body-registered', {
              seat: 'sidebar.right.pane.tab',
              key: PLUGIN_ID,
              outcome,
              hasDisposer: typeof dispose === 'function',
            });
            return dispose;
          });
        });

        contribute('输入框画像开关', () => {
          // `conversation.input.permission` is a SINGLE slot: registering into it
          // shadows the permission selector instead of sitting beside it. The row's
          // list slot renders right after the permission + plan group, so the 画像
          // control lands next to it without touching either of them.
          slots.inject('conversation.input.left', () =>
            slots.register(
              {
                name: 'conversation.input.left',
                id: 'user-portrait-mode',
                inject: (sessionId) => ({ sessionId }),
              },
              PortraitModeControl,
            ),
          );
        });
        contribute('会话头部按钮', () => {
          slots.inject('conversation.session.header.utilities', () =>
            slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: 'user-portrait',
                order: 40,
                inject: () => ({ openPortrait: openPanel }),
              },
              PortraitHeaderAction,
            ),
          );
        });

        contribute('设置页', () => {
          slots.inject('settings.section', () =>
            slots.register(
              {
                name: 'settings.section',
                id: 'user-portrait',
                order: 80,
                label: () => '人物画像',
                inject: () => ({}),
              },
              PortraitSettingsSection,
            ),
          );
        });

        // Report the registration outcome to the Host: if the pane still ends up
        // blank, these lines say which seat took the registration and which did
        // not, without needing the renderer's console.
        reportToHost('apply', {
          bodyKey: PLUGIN_ID,
          tabTypeId: PLUGIN_ID,
          tabKind: TAB_KIND,
          tabsService: firstAttempt.state,
          contributed: contributedSeats,
          failures,
          styleTags:
            typeof document === 'undefined'
              ? 0
              : document.querySelectorAll('style[data-plugin-css]').length,
        });
      },
    };
  },
});


















