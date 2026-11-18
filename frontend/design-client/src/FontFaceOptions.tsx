import { bundledTypefaceOptions, isBundledTypeface } from './bundled-import-fonts'
import type { DesignDocument } from './model'
import { usePropertyText } from './property-interface-messages'

export function FontFaceOptions({ fonts }: { fonts: DesignDocument['fonts'] }) {
  const { tr } = usePropertyText()
  const documentFonts = Object.entries(fonts ?? {}).filter(([id]) => !isBundledTypeface(id))
  return <>
    <optgroup label={tr('内置字体')}>
      <option value="default">{tr('Noto Sans SC（内置）')}</option>
      {bundledTypefaceOptions.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
    </optgroup>
    {documentFonts.length > 0 && <optgroup label={tr('文档字体')}>
      {documentFonts.map(([id, font]) => <option key={id} value={id}>{font.family}</option>)}
    </optgroup>}
  </>
}
