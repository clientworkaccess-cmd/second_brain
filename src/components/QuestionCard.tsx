'use client';

import { useState } from 'react';
import { SendHorizonal } from 'lucide-react';
import { Button } from '@/components/ui';
import { SKIP_MESSAGE, answersMessage, type Pick, type Question } from '@/lib/questions';

/**
 * The questions a reply asked before answering (lib/questions.ts), as a card:
 * each question with its suggested answers to pick (one, or several when it
 * allows), and a line for an answer of the reader's own. The answers go back
 * as one ordinary message in the conversation; so does "just answer".
 *
 * Only the latest reply's card can be answered. An earlier one is shown as it
 * was, closed: what the reader answered is the message under it.
 */
export function QuestionCard({ questions, open, onSend }: { questions: Question[]; open: boolean; onSend: (message: string) => void }) {
  const [picks, setPicks] = useState<Pick[]>(() => questions.map(() => ({ chosen: [], other: '' })));
  const message = answersMessage(questions, picks);

  const toggle = (qi: number, option: string): void => {
    setPicks((all) =>
      all.map((pick, i) => {
        if (i !== qi) return pick;
        const has = pick.chosen.includes(option);
        if (questions[qi].multi) return { ...pick, chosen: has ? pick.chosen.filter((c) => c !== option) : [...pick.chosen, option] };
        return { ...pick, chosen: has ? [] : [option] };
      }),
    );
  };
  const write = (qi: number, other: string): void => setPicks((all) => all.map((pick, i) => (i === qi ? { ...pick, other } : pick)));

  return (
    <div className="question-card" data-questions={open ? 'open' : 'answered'}>
      <div className="question-card-head">{questions.length === 1 ? 'A question before I answer' : 'A few questions before I answer'}</div>
      {questions.map((q, qi) => (
        <fieldset key={qi} className="question" disabled={!open}>
          <legend className="question-text">{q.question}</legend>
          {q.options.length > 0 && (
            <div className="question-options" role={q.multi ? 'group' : 'radiogroup'} aria-label={q.question}>
              {q.options.map((option) => {
                const on = picks[qi].chosen.includes(option);
                return (
                  <button
                    key={option}
                    type="button"
                    className={`question-option${on ? ' is-on' : ''}`}
                    role={q.multi ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    onClick={() => toggle(qi, option)}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          )}
          <input
            className="question-other"
            type="text"
            value={picks[qi].other}
            onChange={(e) => write(qi, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && message) {
                e.preventDefault();
                onSend(message);
              }
            }}
            placeholder={q.options.length ? (q.multi ? 'Or add your own…' : 'Or your own answer…') : 'Your answer…'}
            aria-label={`Your own answer to: ${q.question}`}
          />
        </fieldset>
      ))}
      {open ? (
        <div className="question-actions">
          <Button type="button" variant="quiet" onClick={() => onSend(SKIP_MESSAGE)} title="Let it answer now, on its own assumptions">
            Skip, just answer
          </Button>
          <Button type="button" onClick={() => message && onSend(message)} disabled={!message}>
            <SendHorizonal size={14} />
            Send answers
          </Button>
        </div>
      ) : (
        <p className="muted small">Answered in the message below.</p>
      )}
    </div>
  );
}
