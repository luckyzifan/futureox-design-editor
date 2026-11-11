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
  expect(sourceErrorSummary('DOCUMENT_RESOURCE_LIMIT: allowance 2147483648-byte working-memory budget')).toContain('内存')
  expect(sourceErrorSummary('页面准备期间产生了新修改；当前画布已保留。')).toContain('当前画布已保留')
  expect(sourceErrorSummary('unsupported imported document')).toContain('技术详情')
})

test('a Sketch library admission failure stays an error with the repair, not a ready file',()=>{
 const error='unsupported lossless conversion: Sketch instance requires an embedded symbol master: 6F0139C2-C417-4447-8E8B-5926F071C14F。这是缺失的外部库符号定义，不是无法映射的字段。修复：在原生导入时附上包含该 symbolID 的本地 .sketch 库。不会发明主组件。'
 expect(sourceErrorSummary(error)).toContain('不会发明主组件')
 expect(sourceErrorSummary(error)).toContain('6F0139C2')
 const html=renderToStaticMarkup(<SourceDocumentStatus source={{error,notice:'',busy:false,warnings:[]} as unknown as SourceWorkspace}/>)
 expect(html).toContain('操作未完成')
 expect(html).not.toContain('文件已就绪')
 expect(html).toContain('role="alert"')
 expect(html).toContain('技术详情')
})

test('native rendering progress is not labelled as a ready file',()=>{
 const source={error:'',notice:'正在绘制完整画板 1 / 20…',busy:false,warnings:[],nativeCanvas:{status:{phase:'refining',done:1,total:20}}} as unknown as SourceWorkspace
 const html=renderToStaticMarkup(<SourceDocumentStatus source={source}/>)
 expect(html).toContain('正在绘制');expect(html).not.toContain('文件已就绪')
})

test('a conversion-window reject names the fixed limit, keeps the original text, and offers the smaller-subtree entry',()=>{
 const error='大型文档：Source subtree exceeds the bounded conversion window; select a smaller subtree'
 const html=renderToStaticMarkup(<SourceDocumentStatus source={{error,notice:'',busy:false,warnings:[],failureStage:'refine',stageReport:{
  directory:{status:'ready',detail:'目录：2 页 / 3 个素材'},
  preview:{status:'ready',detail:'预览：3/3 张缩略图'},
  refine:{status:'rejected',detail:'完整精修：超过固定转换窗口，尚未完成'},
  edit:{status:'idle',detail:'编辑尚未开始'},
 }} as unknown as SourceWorkspace}/>)
 expect(html).toContain('完整精修未完成')
 expect(html).toContain('固定转换窗口')
 expect(html).toContain('选择较小页面、素材或子树')
 expect(html).toContain('无需退出其他应用')
 expect(html).not.toContain('可释放其他应用的内存后重试')
 expect(html).toContain(error)
 expect(html).toContain('data-stage="directory"')
 expect(html).toContain('data-status="ready"')
 expect(html).toContain('data-stage="refine"')
 expect(html).toContain('data-status="rejected"')
 expect(html).toContain('data-stage="edit"')
 expect(html).toContain('data-status="idle"')
 expect(html).toContain('技术详情')
})

test('background viewport refinement does not reopen the file loading card',()=>{
 const source={error:'',notice:'正在准备画板',busy:true,warnings:[],navigatingMaterials:true} as unknown as SourceWorkspace
 expect(renderToStaticMarkup(<SourceDocumentStatus source={source}/>)).not.toContain('source-status-card')
 expect(renderToStaticMarkup(<SourceDocumentStatus source={{...source,error:'读取失败'}}/>)).toContain('role="alert"')
})
