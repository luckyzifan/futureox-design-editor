import uiCode from './sample-ui/code.js?raw'
import uiHtml from './sample-ui/ui.html?raw'
import uiManifest from './sample-ui/manifest.json'
import sampleCode from './sample/code.js?raw'
import sampleManifest from './sample/manifest.json'
import { parsePluginManifest, type PluginBundle } from './manifest'

export function samplePluginBundle(): PluginBundle {
  return { manifest: parsePluginManifest(sampleManifest), main: sampleCode, ui: null }
}

export function sampleUiPluginBundle(): PluginBundle {
  return { manifest: parsePluginManifest(uiManifest), main: uiCode, ui: uiHtml }
}
