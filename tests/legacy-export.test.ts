import { after, before, test } from 'node:test';
import { createQaContext, editorQaCases, type QaContext } from '../scripts/editor-qa';
let context: QaContext;
before(
  async () => {
    context = await createQaContext();
  },
  { timeout: 60000 },
);
after(async () => {
  await context?.close();
});
for (const item of editorQaCases)
  test(`editor: ${item.name}`, { timeout: 60000 }, async () => {
    await item.run(context);
  });
