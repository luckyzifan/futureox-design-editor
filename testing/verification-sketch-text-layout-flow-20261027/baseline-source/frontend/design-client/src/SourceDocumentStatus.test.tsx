import {expect,test} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import {SourceDocumentStatus,sourceErrorSummary} from './SourceDocumentStatus'
import type {SourceWorkspace} from './LargeDocumentWorkspace'

const screenshotError="invalid imported document: DOCUMENT_RESOURCE_LIMIT: document structure exceeds this session's allowance (256 nodes, 1024 pages; 1048576-byte working-memory budget)"
test('the reported 1 MiB failure has a readable remedy while native details remain available',()=>{
  const error=sourceErrorSummary(screenshotError)
  expect(error).toContain('1 MiB')
  expect(error).toContain('启动配置')
  expect(error).not.toContain('DOCUMENT_RESOURCE_LIMIT')
  const html=renderToStaticMarkup(<SourceDocumentStatus source={{error:screenshotError,notice:'',busy:false,warnings:[]} as unknown as SourceWorkspace}/>)
  expect(html).toContain('技术详情')
  expect(html).toContain('DOCUMENT_RESOURCE_LIMIT')
  expect(html.match(/role="alert">(.*?)<\/p>/)?.[1]).toContain('启动配置')
})
test('ordinary pressure and source conflict messages do not invent a low startup configuration',()=>{
  expect(sourceErrorSummary('DOCUMENT_RESOURCE_LIMIT: allowance 2147483648-byte working-memory budget')).toContain('较小的画板')
  expect(sourceErrorSummary('页面准备期间产生了新修改；当前画布已保留。')).toContain('当前画布已保留')
  expect(sourceErrorSummary('unsupported imported document')).toContain('技术详情')
})
