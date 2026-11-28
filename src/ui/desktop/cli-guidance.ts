import type { CliLink } from "../../model/index.ts";

export const CLI_COMMAND = "npx unlab.run";

export function cliGuidance(cli: CliLink): string {
	switch (cli.kind) {
		case "off":
			return "The link is off. Run the CLI in a terminal on this computer, and it opens the lab and links to it:";
		case "waiting":
			return "Waiting for the CLI. Run it in a terminal on this computer, and allow the lab to reach apps on this device if your browser asks:";
		case "blocked":
			return "Your browser does not let the lab reach apps on this device. Select the icon left of the address, allow it there, and reload. Then run:";
		case "linked":
			return "Linked to the CLI on this computer. It was started with:";
		case "refused":
			return cli.message;
	}
}
