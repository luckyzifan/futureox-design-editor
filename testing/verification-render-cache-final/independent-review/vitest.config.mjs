import { fileURLToPath } from 'node:url'
const original='/workspace/shared/design-latest-20261019T1209'
const repository=process.env.REVIEW_REPOSITORY || original
const directory=fileURLToPath(new URL('.',import.meta.url))
export default {
  resolve:{alias:[{find:original,replacement:repository}]},
  test:{setupFiles:[`${repository}/frontend/design-client/src/test-setup.ts`],include:[`${directory}*.test.ts`],
    fileParallelism:false,maxWorkers:1,testTimeout:30000}
}
