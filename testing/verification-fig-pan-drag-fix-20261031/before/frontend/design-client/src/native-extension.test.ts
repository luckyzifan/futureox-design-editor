import {expect,test} from 'vitest'
import {readDesignFile} from './persistence'
import {blank} from './model'
import {encodeDocumentBinary} from './kernel/binfmt'

test('FD opens the authored binary document; old Forma suffix is explicitly rejected',async()=>{
  const doc=blank('futureox-desgin'),bytes=encodeDocumentBinary(doc)
  for(const name of ['design.fd','design.FD']){
    const opened=await readDesignFile(new File([new Uint8Array(bytes).buffer],name))
    expect(opened.document).toEqual(doc)
  }
  for(const name of ['design.forma','design.FORMA','design.fd.exe'])
    await expect(readDesignFile(new File([new Uint8Array(bytes).buffer],name))).rejects.toThrow(/请选择 .fd/)
})
