import { icon } from "./icons.ts";

export const workspace = `
	<header class="topbar">
		<div class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M3 8h7v12h6v5H7l-4-4zm11-4h6v13h-6zm9 6h6v15H17v-5h6z"/></svg>unlab</div>
		<span class="workspace-name">Network workspace</span>
		<div class="right">
			<button id="toggle-machines" class="mobile-only" aria-expanded="false" aria-controls="side">${icon("panel")} Machines</button>
			<button id="toggle-wire" aria-label="Inspector" aria-controls="wire" title="Toggle packet inspector">${icon("wire")} <span>Inspector</span></button>
			<button id="add" class="primary" disabled>${icon("plus")} Add machine</button>
		</div>
	</header>
	<aside class="side" id="side" aria-label="Machines">
		<h2 class="section-label">Machines <span class="count" id="machine-count"></span></h2>
		<div id="machines"></div>
		<h2 class="section-label detail-heading">Machine details</h2>
		<div id="detail"></div>
	</aside>
	<main class="workspace">
		<section class="map-panel panel" aria-labelledby="map-title">
			<div class="panel-head"><h1 id="map-title">${icon("network")} Network topology</h1><span id="subnet" class="subnet"></span></div>
			<div class="map-canvas"><div id="topo"></div></div>
			<div class="map-foot"><span class="legend"><i></i> Link up</span><span class="legend down"><i></i> Link down</span><span class="map-hint">Click a cable to toggle its link</span></div>
		</section>
		<div class="instruments">
			<section class="terminal-panel panel" aria-label="Terminal">
				<div class="panel-head"><h2>${icon("terminal")} Terminal</h2><button id="new-shell" title="Open a new shell on this machine">${icon("plus")} New shell</button></div>
				<div class="tabstrip" id="tabstrip" aria-label="Open sessions"></div>
				<div class="terminal-area"><div class="panes" id="panes"></div><div class="nothing" id="nothing"><b>No open sessions</b><span>Select a machine to open its console.</span></div></div>
			</section>
			<section class="wire panel" id="wire" aria-label="Packet inspector">
				<div class="panel-head"><h2>${icon("pulse")} Packet capture</h2><span class="capture-state" id="capture-state">Live</span></div>
				<div class="controls"><label class="filter">${icon("search")}<input type="search" id="pkt-filter" aria-label="Filter packets" placeholder="Filter packets…" /></label>
					<button id="pause" class="icon-btn" title="Pause capture" aria-label="Pause capture">${icon("pause")}</button>
					<button id="clear-pkts" class="icon-btn" title="Clear capture" aria-label="Clear capture">${icon("clear")}</button></div>
				<div class="pkt-head"><span>Time (s)</span><span>Proto</span><span>Route</span></div>
				<div class="packets" id="packets"></div><div class="stats" id="stats"></div>
				<details class="mac-table"><summary>MAC address table</summary><div class="mac" id="mac"></div></details>
			</section>
		</div>
	</main>
	<footer class="statusbar"><span class="lab-status"><i class="dot" id="lab-dot"></i><span id="lab-status">Starting lab</span></span><span id="session-count"></span><span class="runtime">unkernel <b>/</b> WebAssembly</span></footer>

	<dialog id="add-dialog" aria-labelledby="add-title"><form id="machine-form">
		<div class="dialog-head"><h2 id="add-title">Add machine</h2><button type="button" id="cancel-add" class="icon-btn" aria-label="Close dialog">${icon("close")}</button></div>
		<label>Machine name<input type="text" id="new-name" placeholder="Auto-assign name" autofocus /></label>
		<label>Image<select id="new-distro"></select></label>
		<label class="net-option"><input type="checkbox" id="new-net" /> Internet access via public Wisp proxy</label>
		<button class="primary" type="submit">${icon("plus")} Add machine</button>
	</form></dialog>`;
