import type { Lab } from "../lab/lab.ts";
import { machineColor } from "./sidebar.ts";

// Pixel silhouettes share the same two-unit grid. The phosphor and case pick up
// each host's colour from the machine list.
const workstation = `<g shape-rendering="crispEdges">
	<path fill="var(--crust)" d="M-34 16h60v3h9v5h-68z"/>
	<path fill="var(--case-shadow)" d="M-29 8h48v4h8v4h7v6h-64v-3h-6v-5h7z"/>
	<path fill="var(--case-light)" d="M-26 8h42v3h7v3h7v3h-62v-4h6z"/>
	<path fill="var(--case-mid)" d="M-32 17h62v4h-62z"/>
	<path fill="var(--case-dark)" d="M-15 12h32v2h6v2h-38zM20 18h5v2h-5z"/>
	<path fill="var(--case-shadow)" d="M-23-32h42v3h6v4h3v30h-4v4h-7v4h-39V9h-4v-37h3z"/>
	<path fill="var(--case-mid)" d="M12-27h12v3h2V3h-4v4h-9z"/>
	<path fill="var(--case-light)" d="M-23-31h36v3h5V7h-4v3h-36V7h-4v-35h3z"/>
	<path fill="var(--case-dark)" d="M-20-25h32v25h-32z"/>
	<path fill="var(--screen)" d="M-18-23h28v21h-28z"/>
	<path fill="currentColor" d="M-14-18h3v2h3v3h-3v2h-3v-3h3v-2h-3zM-6-11h8v2h-8z"/>
	<path fill="var(--case-mid)" d="M-18 3h13v2h-13zM19-19h5v2h-5zm0 5h5v2h-5zm0 5h5v2h-5z"/>
	<path fill="var(--screen)" d="M7 3h4v2H7z"/>
</g>`;

const networkSwitch = `<g shape-rendering="crispEdges">
	<path fill="var(--crust)" d="M-43 9h87v7h-87z"/>
	<path fill="var(--overlay0)" d="M-43-8h6v-4h7v-4h62v3h6v4h6v18h-6v4h-81z"/>
	<path fill="var(--surface2)" d="M-40-7h77v4h-77z"/>
	<path fill="var(--surface0)" d="M-41-4h76v14h-76z"/>
	<path fill="var(--surface1)" d="M35-4h6v11h-6z"/>
	<path fill="var(--crust)" d="M-34-1h9v7h-9zm13 0h9v7h-9zm13 0h9v7h-9zm13 0h9v7H5z"/>
	<path fill="var(--yellow)" d="M-33 0h4v2h-4zm13 0h4v2h-4z"/>
	<path fill="var(--green)" d="M20 0h3v3h-3zm6 0h3v3h-3z"/>
	<path fill="var(--surface1)" d="M-19-11h32v2h-32zm6-4h30v2h-30z"/>
</g>`;

function escapeText(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderTopology(host: HTMLElement, lab: Lab, activeId: string | undefined, onSelect: (id: string) => void): void {
	if (!lab.machines.length) {
		host.innerHTML = '<div class="map-empty">Add a machine to connect it to the switch.</div>';
		return;
	}
	const width = Math.min(760, Math.max(300, host.clientWidth));
	const rows = Math.ceil(lab.machines.length / 2);
	const height = rows * 118 + 20;
	const switchX = width / 2;
	const switchY = (rows - 1) * 59 + 58;
	const devices: string[] = [];
	const cables: string[] = [];
	lab.machines.forEach((m, index) => {
		const left = index % 2 === 0;
		const inset = Math.round(width * 0.145);
		const x = left ? inset : width - inset;
		const y = Math.floor(index / 2) * 118 + 60;
		const sign = left ? 1 : -1;
		const edge = switchX - sign * 42;
		const bend = (edge + x + sign * 34) / 2;
		const path = `M${x + sign * 34} ${y + 6} H${bend} V${switchY + 8} H${edge}`;
		const name = escapeText(m.name);
		const color = machineColor(index);
		cables.push(`<g class="map-link ${m.link ? "" : "down"}" data-cable="${m.id}">
			<title>${m.link ? "Disconnect" : "Connect"} ${name}</title>
			<path class="link-hit" d="${path}"/><path class="link-line" d="${path}"/>
			<rect x="${x + sign * 35 - 2}" y="${y + 4}" width="4" height="4"/></g>`);
		devices.push(`<g class="device ${m.id === activeId ? "selected" : ""}" data-device="${m.id}" style="color:${color}" transform="translate(${x} ${y})">
			<title>${name} · ${m.ip} · ${m.state}</title>
			<rect class="device-hit" x="-34" y="-40" width="68" height="112"/>
			${workstation}<text class="map-name" y="44">${m.name.length > 16 ? escapeText(m.name.slice(0, 15)) + "…" : name}</text>
			<text class="map-address" y="61">${m.ip}</text></g>`);
	});
	host.innerHTML = `<svg class="topo" style="height:${height}px" viewBox="0 0 ${width} ${height}" aria-label="Network wiring diagram">
		${cables.join("")}<g transform="translate(${switchX} ${switchY})">${networkSwitch}
		<text class="map-name" y="44">switch0</text><text class="map-address" y="61">L2 switch</text></g>${devices.join("")}</svg>`;
	host.onclick = (event) => {
		if (!(event.target instanceof Element)) return;
		const cable = event.target.closest<SVGGElement>("[data-cable]")?.dataset.cable;
		const device = event.target.closest<SVGGElement>("[data-device]")?.dataset.device;
		if (cable) {
			const m = lab.byId(cable);
			if (m) m.setLink(!m.link);
		} else if (device) onSelect(device);
	};
}
