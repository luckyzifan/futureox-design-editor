import { expect, test } from 'vitest'
import { presentChrome } from './english-chrome'
import { translateProfessional } from './professional-dialog-messages'
import { translateProperty } from './property-interface-messages'

const han = /\p{Script=Han}/u

test('English chrome translates product copy and leaves authored text unchanged', () => {
  expect(presentChrome('评论', 'en')).toBe('Comments')
  expect(presentChrome('本地评论与标注', 'en')).toBe('Local comments and annotations')
  expect(presentChrome('笔刷宽度', 'en')).toBe('Brush width')
  expect(presentChrome('3 条消息', 'en')).toBe('3 messages')
  expect(presentChrome('1 条消息', 'en')).toBe('1 message')
  expect(presentChrome('撤销：修改属性', 'en')).toBe('Undo: Edit properties')
  expect(presentChrome('撤销：作者保存', 'en')).toBe('Undo: 作者保存')
  expect(presentChrome('创建便签', 'en')).toBe('Create Sticky note')
  expect(presentChrome('创建副本', 'en')).toBe('Duplicate')
  expect(presentChrome('调整 笔宽', 'en')).toBe('Adjust Stroke width')
  expect(presentChrome('位置 2 (%)', 'en')).toBe('Position 2 (%)')
  expect(presentChrome('作者保存', 'en')).toBe('作者保存')
  expect(presentChrome('未命名设计', 'en')).toBe('未命名设计')
  expect(presentChrome('Frame A', 'en')).toBe('Frame A')
  expect(presentChrome('本机用户', 'en')).toBe('本机用户')
  const diagnosis = 'unsupported lossless conversion: symbol 6F0139C2。这是缺失的外部库符号定义。作者图层 Frame A'
  expect(presentChrome(diagnosis, 'en')).toBe(diagnosis)
  expect(presentChrome('评论', 'zh-CN')).toBe('评论')
  expect(translateProfessional('作者保存', 'en')).toBe('作者保存')
  expect(translateProfessional('未命名设计', 'en')).toBe('未命名设计')
  expect(translateProfessional('历史版本', 'en')).toBe('Version history')
  expect(translateProfessional('请先保存或取消评论草稿', 'en')).toBe('Save or cancel the comment draft first')
  expect(translateProfessional('设计内核载入失败：TypeError: missing', 'en')).toBe('Design kernel failed to load: TypeError: missing')
  expect(translateProfessional(diagnosis, 'en')).toBe(diagnosis)
  expect(translateProfessional(diagnosis, 'en')).toContain('作者图层 Frame A')
  expect(translateProfessional(diagnosis, 'en')).not.toContain('Author layer')
  expect(translateProperty('笔刷宽度', 'en')).toBe('Brush width')
  expect(translateProperty('不透明度 %', 'en')).toBe('Opacity %')
  expect(translateProperty('Frame A', 'en')).toBe('Frame A')
  const brushHelp = '源图形使用当前图层的填充。Scatter 保留贝塞尔曲线。Stretch 在同向直线上是精确仿射；曲线、拐角、尖点和闭合路径按有界弧长与法线映射。'
  expect(translateProfessional(brushHelp, 'en')).toBe('The source shape uses this layer’s fill. Scatter keeps Bézier curves. Stretch is an exact affine map on a straight line in the same direction. Curves, corners, cusps and closed paths use a bounded arc length and normal.')
  expect(translateProperty('非等比或斜切变换：此数值按最大缩放系数换算，不代表各方向的实际尺寸。编辑仍按同一系数换回局部作者值。', 'en')).toContain('largest scale factor')
  expect(translateProfessional('编辑：已载入 Frame A', 'en')).toBe('Edit: loaded Frame A')
  for (const sample of ['Comments', 'Brush width', 'Save or cancel the comment draft first', 'Undo: Edit properties', 'Position 2 (%)']) {
    expect(sample).not.toMatch(han)
  }
})
