// Pull in the three Obsidian classes we need:
//   App             — the top-level Obsidian application object (passed to every plugin/tab)
//   PluginSettingTab — base class that Obsidian calls to render a plugin's settings page
//   Setting         — builder that renders a single labelled row in the settings UI
import { App, PluginSettingTab, Setting } from "obsidian";

// Import our plugin class so the settings tab can call saveSettings() on it.
// This is a circular-looking import but TypeScript/esbuild handles it fine because
// we only use the type at compile time and the instance at runtime.
import SquarespaceExportPlugin from "./main";

// The shape of our saved settings object.
// Obsidian serialises this to JSON in the plugin's data.json file automatically.
export interface SquarespaceExportSettings {
    outputFolder: string;   // vault-relative folder where .html files are written
    embedCss: boolean;      // whether to inline the CSS block in the exported file
    openAfterExport: boolean; // whether to open the exported file in Obsidian immediately
}

// The values used on first install, or if a setting key is missing from saved data.
// Object.assign(DEFAULT_SETTINGS, savedData) in main.ts ensures new keys always have a fallback.
export const DEFAULT_SETTINGS: SquarespaceExportSettings = {
    outputFolder: "squarespace-exports",
    embedCss: true,
    openAfterExport: false,
};

// PluginSettingTab is the Obsidian base class for the settings page.
// Obsidian calls display() every time the user opens this plugin's settings tab.
export class SquarespaceExportSettingTab extends PluginSettingTab {
    plugin: SquarespaceExportPlugin; // reference back to the plugin so we can read/write settings

    constructor(app: App, plugin: SquarespaceExportPlugin) {
        super(app, plugin); // required — passes app and plugin to the Obsidian base class
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this; // the DOM element Obsidian gives us to render into
        containerEl.empty(); // clear any previously rendered content before re-drawing

        // --- Output folder setting ---
        // addText renders a text input. setPlaceholder shows grey hint text when empty.
        // onChange fires on every keystroke — we save immediately so nothing is lost.
        new Setting(containerEl)
            .setName("Output folder")
            .setDesc("Vault folder where exported HTML files are saved.")
            .addText(text => text
                .setPlaceholder("squarespace-exports")
                .setValue(this.plugin.settings.outputFolder)
                .onChange(async (value) => {
                    this.plugin.settings.outputFolder = value;
                    await this.plugin.saveSettings();
                }));

        // --- Embed CSS toggle ---
        // addToggle renders an on/off switch.
        new Setting(containerEl)
            .setName("Embed CSS")
            .setDesc("Include styles in the exported HTML.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.embedCss)
                .onChange(async (value) => {
                    this.plugin.settings.embedCss = value;
                    await this.plugin.saveSettings();
                }));

        // --- Open after export toggle ---
        new Setting(containerEl)
            .setName("Open after export")
            .setDesc("Open the exported file in Obsidian after saving.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.openAfterExport)
                .onChange(async (value) => {
                    this.plugin.settings.openAfterExport = value;
                    await this.plugin.saveSettings();
                }));
    }
}
