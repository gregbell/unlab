import { describe, expect, it } from "vitest";
import { storeLab } from "../testing/store.ts";

describe("capture", () => {
	it("sets the filter and maximises the capture", async () => {
		const lab = storeLab();
		await lab.lab(1);
		expect(lab.parsed("capture icmp node1").preview(lab.store.state)).toMatchObject({
			will: "show captured frames matching icmp node1",
		});
		expect(lab.parsed("capture").preview(lab.store.state)).toMatchObject({ will: "show every captured frame" });
		expect(await lab.run("capture icmp")).toMatchObject({ kind: "visible", text: "showing frames matching icmp" });
		expect(lab.store.state.panels.maximised).toBe("capture");
		expect(lab.store.state.capture.filter).toBe("icmp");
	});

	it("refuses a filter it cannot read", () => {
		const lab = storeLab();
		expect(lab.parsed("capture icmp bogus").validate(lab.store.state)).toEqual({
			message:
				"capture cannot read bogus. A term is a protocol, a machine, a NIC (node2:eth1), an address, a MAC or port:N. Nothing was changed.",
			token: 1,
		});
	});
});
