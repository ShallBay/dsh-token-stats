// @deepseek-ai/dsh-token-stats — client half (browser plugin bundle).
//
// Adds a "Token 用量" entry to the web sidebar's footer actions row, which the
// sidebar shell renders above the Settings seat (slot 'sidebar.footer.action',
// declared by dsh-client-ui-sidebar). Clicking opens the token usage dashboard
// (/token-stats, served by this package's host half):
//   · Web — a new browser tab.
//   · Desktop — an in-app popup window (iframe overlay), because the Electron
//     shell denies every window.open and routes only http(s) to the system
//     browser. The page is still reached through the shell's own proxy, which
//     forwards it to the authenticated host.
//
// Bundle format: the shell's __ModuleLoader__ CommonJS-style wrapper; only
// 'react' is required (available in the shell's module registry). No build
// step — this file is served raw at /plugins/@deepseek-ai/dsh-token-stats/client.js.
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-token-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		const { createElement } = react;

		// region sidebar footer action
		const CSS_TAG = "@deepseek-ai/dsh-token-stats/sidebar-action";
		if (typeof document !== "undefined") {
			// Reuse the tag but always rewrite its text: a hot-reloaded revision must not
			// keep the styles an earlier one injected into this document.
			const existing = document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]");
			const tag = existing === null ? document.createElement("style") : existing;
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = [
				".dsh-token-stats-action{display:inline-flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;padding:7px 10px;border-radius:8px;color:var(--dsw-alias-label-secondary,#8a8f98);cursor:pointer;font-family:inherit}",
				".dsh-token-stats-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,#e6e6e6)}",
				".dsh-token-stats-action:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,rgba(76,140,255,.9));outline-offset:-2px}",
				".dsh-token-stats-action .label{font-size:13px;font-weight:500;white-space:nowrap}",
				// in-app popup window (desktop only) — light surface, matching the dashboard page
				".dsh-token-stats-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:2.5vh 2.5vw;background:rgba(3,6,14,.62);backdrop-filter:blur(2px)}",
				".dsh-token-stats-panel{display:flex;flex-direction:column;width:min(1360px,96vw);height:min(900px,92vh);overflow:hidden;background:#f4f6fb;border:1px solid rgba(15,23,42,.18);border-radius:14px;box-shadow:0 24px 64px rgba(15,23,42,.34)}",
				".dsh-token-stats-panelbar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 9px 7px 14px;background:#ffffff;border-bottom:1px solid rgba(15,23,42,.10)}",
				".dsh-token-stats-paneltitle{font-size:13px;font-weight:600;color:#17223b;font-family:inherit}",
				".dsh-token-stats-panelclose{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;flex:none;border:none;border-radius:7px;background:transparent;color:#5a6a8a;cursor:pointer;font-size:13px;line-height:1;font-family:inherit}",
				".dsh-token-stats-panelclose:hover{background:rgba(15,23,42,.07);color:#17223b}",
				".dsh-token-stats-frame{flex:1;width:100%;min-height:0;border:0;display:block;background:#f4f6fb}",
				"@media (max-width:760px){.dsh-token-stats-overlay{padding:0}.dsh-token-stats-panel{width:100vw;height:100vh;border-radius:0;border:none}}"
			].join("");
			if (existing === null) document.head.appendChild(tag);
		}

		// region in-app popup window (desktop)
		/**
		* Desktop documents live on the dsh-app:// scheme, where the shell denies
		* every window.open. Detect it so the entry can open the popup instead.
		*/
		const IS_DESKTOP = typeof location !== "undefined" && location.protocol === "dsh-app:";
		const OVERLAY_ID = "dsh-token-stats-overlay";

		/** Close the popup and drop its Escape listener. */
		function closeTokenStatsPanel() {
			const existing = document.getElementById(OVERLAY_ID);
			if (existing === null) return;
			existing.remove();
			document.removeEventListener("keydown", onPanelKey, true);
		}

		/** Escape closes the popup before it reaches the shell. */
		function onPanelKey(event) {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			closeTokenStatsPanel();
		}

		/**
		* Open the dashboard in a titled in-app window: a fixed overlay hosting the
		* host-served page in an iframe. The overlay is appended to document.body,
		* so no transformed ancestor can re-anchor its fixed positioning.
		*/
		function openTokenStatsPanel() {
			if (document.getElementById(OVERLAY_ID) !== null) return;
			const overlay = document.createElement("div");
			overlay.id = OVERLAY_ID;
			overlay.className = "dsh-token-stats-overlay";
			overlay.addEventListener("mousedown", (event) => {
				if (event.target === overlay) closeTokenStatsPanel();
			});
			const panel = document.createElement("div");
			panel.className = "dsh-token-stats-panel";
			panel.setAttribute("role", "dialog");
			panel.setAttribute("aria-label", "Token 用量");
			const bar = document.createElement("div");
			bar.className = "dsh-token-stats-panelbar";
			const title = document.createElement("span");
			title.className = "dsh-token-stats-paneltitle";
			title.textContent = "Token 用量";
			const close = document.createElement("button");
			close.type = "button";
			close.className = "dsh-token-stats-panelclose";
			close.title = "关闭（Esc）";
			close.setAttribute("aria-label", "关闭");
			close.textContent = "\u2715";
			close.addEventListener("click", closeTokenStatsPanel);
			bar.append(title, close);
			const frame = document.createElement("iframe");
			frame.className = "dsh-token-stats-frame";
			frame.title = "Token 用量看板";
			frame.src = "/token-stats?embed=1";
			panel.append(bar, frame);
			overlay.append(panel);
			document.body.appendChild(overlay);
			document.addEventListener("keydown", onPanelKey, true);
		}
		// endregion

		/** Minimal bar-chart glyph (inline SVG, follows currentColor). */
		const TokenStatsIcon = () => createElement("svg", {
			width: 14,
			height: 14,
			viewBox: "0 0 16 16",
			fill: "none",
			"aria-hidden": true,
			style: { flex: "none" }
		},
			createElement("rect", { x: 1.5, y: 8.5, width: 3, height: 6, rx: 1, fill: "currentColor" }),
			createElement("rect", { x: 6.5, y: 4.5, width: 3, height: 10, rx: 1, fill: "currentColor", opacity: 0.75 }),
			createElement("rect", { x: 11.5, y: 1.5, width: 3, height: 13, rx: 1, fill: "currentColor", opacity: 0.5 })
		);

		/**
		* Footer action trigger row. Owner passes only the column state; the wide
		* label is hidden in the 56px rail (icon-only), matching the shell's
		* other foot actions.
		* @param props - { wide: boolean } from the sidebar shell.
		*/
		function TokenStatsAction({ wide }) {
			const open = () => {
				if (IS_DESKTOP) {
					openTokenStatsPanel();
					return;
				}
				window.open("/token-stats", "_blank", "noopener");
			};
			return createElement("button", {
				type: "button",
				className: "dsh-token-stats-action",
				title: "Token 用量",
				"aria-label": "Token 用量",
				onClick: open
			}, createElement(TokenStatsIcon), wide === true ? createElement("span", { className: "label" }, "Token 用量") : null);
		}
		// endregion

		// region plugin entry
		/** Required client services: the slot registry (provided by dsh-client-runtime). */
		const inject = ["slots"];

		/**
		* Register the sidebar foot action. The slot is declared by the sidebar
		* shell, so a plain register (wrapped in slots.inject for activation
		* ordering) is enough.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "token-stats",
				order: 0,
				inject: () => ({})
			}, TokenStatsAction));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
		// endregion
	}
});
