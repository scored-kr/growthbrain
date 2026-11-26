import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import type {BrowserContext} from 'playwright';
import type {ChatService, RenderedTurn} from '../src/adapters.ts';

export async function checkTranscriptAdapters(context: BrowserContext): Promise<void> {
  // Execute the production DOM reader in Chromium on a blank page, using only
  // synthetic markup. The ordinary chat integration is exercised in browser.ts.
  const page = await context.newPage();
  try {
    const source = stripTypeScriptTypes(await readFile(new URL('../src/adapters.ts', import.meta.url), 'utf8'));
    const moduleUrl = await page.evaluate(source => URL.createObjectURL(new Blob([source], {type:'text/javascript'})), source);
    async function scan(service: ChatService, markup: string) {
      return page.evaluate(async ({service, markup, moduleUrl}) => {
        const reader: typeof import('../src/adapters.ts') = await import(moduleUrl);
        document.body.innerHTML = markup;
        const result = reader.renderedTranscript(service);
        const frames = reader.transcriptFrames(service);
        if (frames.length !== result.observed || frames.some((frame,i) => frame !== result.frames[i])) throw Error('Frame metadata disagreed with the captured transcript');
        return {ordered:result.ordered, observed:result.observed, replay:reader.initialCaptureTranscript() !== undefined};
      }, {service, markup, moduleUrl});
    }

    const stable: RenderedTurn[] = [
      {id:'brief',role:'user',text:'상세페이지 초안 세 가지를 써줘.'},
      {id:'drafts',role:'assistant',text:'1안: 하나\n2안: 보관할 문장'},
      {id:'choice',role:'user',text:'2안으로 확정'},
    ];
    const markup = '<main><div>' +
      '<section data-testid="conversation-turn-1" data-turn="user"><h5 class="sr-only">You said</h5><div data-message-id="brief"><p class="whitespace-pre-wrap">상세페이지 초안 세 가지를 써줘.</p></div></section>' +
      '<section data-testid="conversation-turn-assistant" data-turn-id="answer-frame"><div data-message-author-role="assistant"><div data-message-uuid="drafts"><div class="markdown">1안: 하나<br>2안: 보관할 문장</div></div></div></section>' +
      '<section data-testid="conversation-turn-user" data-message-id="choice"><div class="user-message-bubble-color">2안으로 확정</div></section></div></main>';
    const good = await scan('chatgpt', markup);
    assert.deepEqual(good.ordered, stable);
    assert.equal(good.observed, 3);
    assert.equal(good.replay, true);
    assert.deepEqual((await scan('chatgpt','<main><section data-turn="user"><div><div data-message-id="plain"><p>일반 문단</p></div></div></section></main>')).ordered,
      [{id:'plain',role:'user',text:'일반 문단'}]);

    const noStableId = await scan('chatgpt', markup.replace('data-message-id="brief"', 'data-message-id="1"'));
    assert.deepEqual(noStableId.ordered, stable.map(({role,text}) => ({role,text})));
    assert.equal(noStableId.replay, false, 'A position cannot identify an approval or the turns that follow it');
    const split = markup.replace('data-message-uuid="drafts"', '').replace('data-turn-id="answer-frame"', '');
    const partial = await scan('chatgpt', split);
    assert.deepEqual(partial.ordered, [stable[0], ...stable.slice(1).map(({role,text}) => ({role,text}))]);
    assert.equal(partial.replay, false);

    const claude = '<main><div><div data-message-uuid="claude-user"><div data-testid="user-message"><p>질문</p></div></div>' +
      '<div data-message-id="claude-answer" data-testid="assistant-message"><div class="font-claude-response"><details data-testid="thinking"><p>비공개 내부 메모</p></details><div class="standard-markdown">사용자에게 보인 답변</div></div></div></div></main>';
    assert.deepEqual((await scan('claude', claude)).ordered, [
      {role:'user',id:'claude-user',text:'질문'}, {role:'assistant',id:'claude-answer',text:'사용자에게 보인 답변'},
    ]);
    const claudeIdless = await scan('claude', claude.replace('data-message-uuid="claude-user"', '').replace('data-message-id="claude-answer"', ''));
    assert.deepEqual(claudeIdless.ordered, [{role:'user',text:'질문'},{role:'assistant',text:'사용자에게 보인 답변'}]);

    // No main landmark: use an identifiable conversation thread only. Drafts,
    // hidden alternatives, tool/thinking panels, and sidebar messages stay out.
    const excluded = '<aside><div data-testid="user-message">사이드바</div></aside>' +
      '<div role="dialog"><div data-testid="assistant-message">다른 작업</div></div>' +
      '<form><div contenteditable="true" data-testid="user-message">미전송</div></form>' +
      '<div aria-hidden="true"><div data-testid="assistant-message">다른 분기</div></div>';
    const noMain = await scan('claude', excluded + claude.replace('<main>','<section>').replace('</main>','</section>'));
    assert.equal(noMain.ordered.length,2);
    assert.doesNotMatch(JSON.stringify(noMain), /사이드바|다른 작업|미전송|다른 분기|비공개/);
    assert.equal((await scan('chatgpt', '<main><textarea>작성 중</textarea><p>임의의 페이지 문구</p></main>')).observed, 0);

    const conflicting = await scan('chatgpt', markup.replace('data-testid="conversation-turn-user" data-message-id="choice"', 'data-testid="conversation-turn-user" data-turn="assistant" data-message-id="choice"'));
    assert.equal(conflicting.ordered.length, 2);
    assert.equal(conflicting.replay, false);
    const siblingBodies = await scan('chatgpt', markup.replace('2안: 보관할 문장</div>', '2안: 보관할 문장</div><div class="markdown">불명확한 결과</div>'));
    assert.equal(siblingBodies.ordered.length, 3);
    assert.equal(siblingBodies.ordered[1]?.id, undefined, 'Separate visible bodies are eligible only for the local transcript');
    assert.equal(siblingBodies.ordered.at(-1)?.id, undefined);
    assert.equal(siblingBodies.replay, false);

    const rich = '<main><div role="main"><article data-turn="assistant" data-message-id="rich">' +
      '<details data-testid="tool-result"><div class="markdown">내부 도구 자료</div></details>' +
      '<div class="markdown"><p>첫 문단. <strong>강조.</strong><span aria-hidden="true">비공개 장식</span></p>' +
      '<p>둘째 문단.<button>복사하기</button></p><span class="sr-only">안내용 문구</span></div></article></div></main>';
    assert.deepEqual((await scan('chatgpt', rich)).ordered, [{role:'assistant',text:'첫 문단. 강조.\n둘째 문단.'}]);
    const transparent = '<main><article data-turn="user" data-message-id="opacity"><div class="markdown"><span style="opacity:0">이전 분기</span>화면 문장</div></article></main>';
    assert.deepEqual((await scan('chatgpt', transparent)).ordered, [{role:'user',text:'화면 문장'}]);
    const stacked = '<main><div data-testid="assistant-message" data-message-uuid="claude-split"><div class="font-claude-response"><p class="standard-markdown">첫 답변 부분</p></div>' +
      '<div class="font-claude-response"><div data-testid="thinking">생각 과정</div><p class="standard-markdown">다음 답변 부분</p></div></div></main>';
    assert.deepEqual((await scan('claude', stacked)).ordered, [{role:'assistant',text:'첫 답변 부분\n다음 답변 부분'}]);
    const annotatedCode = '<main><article data-turn="assistant" data-message-id="code"><div class="markdown"><div><p>최종안 설명</p><pre><code>코드 내용</code></pre></div></div></article></main>';
    assert.deepEqual((await scan('chatgpt', annotatedCode)).ordered, [{role:'assistant',text:'최종안 설명\n코드 내용'}]);
    assert.equal((await scan('chatgpt', markup.replace('data-message-id="brief"', 'data-message-id="local:fake"'))).ordered[0]?.id, undefined);
    assert.equal((await scan('chatgpt', '<main>' + markup + markup + '</main>')).observed, 0);
  } finally { await page.close(); }
}
