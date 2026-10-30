export default {test:{include:[
  '../../testing/verification-ten-hertz-scheduling-20261020/*.test.ts',
  'src/kernel/navigation-journal.test.ts', 'src/kernel/client.test.ts',
  'src/kernel/navigation-zoom.test.ts', 'src/kernel/render-mailbox.test.ts',
  'src/kernel/resident-presentation.test.ts',
],environment:'node',testTimeout:10000}}
