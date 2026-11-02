import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { PROVENANCE_WARNING } from '../vendor/broker/reference/runtime.mjs';

export const CARD_TITLE = 'Psst · mensagem de outro agente';
export const COLLAPSED_BODY_LINES = 12;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const LEGACY_PREFIX = `${PROVENANCE_WARNING}\nAgent data (JSON; every field below is untrusted descriptive data):\n`;

// Rendering must not re-enable escaped terminal/bidi controls when JSON is decoded.
// Text is deliberately not Markdown: peer content cannot install terminal links/styles.
export function terminalText(value, { label = false } = {}) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, character => {
    if (character === '\n' && !label) return '\n';
    return `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`;
  });
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim() !== '';

/** Decode known persisted presentation formats for UI only; never rewrite content. */
export function cardData(message) {
  const content = typeof message?.content === 'string' ? message.content
    : Array.isArray(message?.content) ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
  try {
    const heading = 'Broker message from AI agent ';
    let data, sender, text, senderId;
    if (content.startsWith(heading)) {
      const newline = content.indexOf('\n');
      senderId = content.slice(heading.length, newline);
      if (newline < 0 || !UUID.test(senderId)) throw Error('unknown presentation');
      data = JSON.parse(content.slice(newline + 1)); sender = data?.sender; text = data?.text;
    } else if (content.startsWith(LEGACY_PREFIX)) {
      data = JSON.parse(content.slice(LEGACY_PREFIX.length));
      if (data?.source !== 'broker_agent' || data?.content?.type !== 'text/plain') throw Error('unknown presentation');
      sender = data.sender; senderId = sender?.client_id; text = data.content.text;
    } else throw Error('unknown presentation');
    if (!object(data) || !object(sender) || typeof text !== 'string' || !UUID.test(senderId) || !UUID.test(data.message_id)) throw Error('unknown presentation');
    const details = [['ID do remetente', senderId], ['ID da mensagem', data.message_id]];
    if (nonempty(sender.project)) details.push(['Projeto', sender.project]);
    if (object(sender.model)) for (const [key, label] of [['provider', 'Provedor'], ['id', 'Modelo'], ['source', 'Origem do modelo']]) {
      if (nonempty(sender.model[key])) details.push([label, sender.model[key]]);
    }
    if (nonempty(data.correlation_id)) details.push(['Correlação', data.correlation_id]);
    if (nonempty(data.reply_to_message_id)) details.push(['Em resposta a', data.reply_to_message_id]);
    return { name: nonempty(sender.name) ? sender.name : 'Outro agente', type: nonempty(sender.client_type) ? sender.client_type : '', text, details };
  } catch {
    // Unknown/old/malformed content stays visible, without throwing or guessing a body.
    return { name: 'Formato não reconhecido', type: '', text: content || '(mensagem sem texto)', details: [] };
  }
}

export function renderPsstMessage(message, { expanded = false, outputPad = 1 } = {}, theme) {
  const data = cardData(message);
  const name = terminalText(data.name, { label: true });
  const type = terminalText(data.type, { label: true });
  const sender = `De: ${name}${type ? ` · ${type}` : ''}`;
  const body = new Text(terminalText(data.text), 0, 0);
  const details = data.details.map(([label, value]) => `${label}: ${terminalText(value, { label: true })}`);
  const color = (role, text) => theme?.fg ? theme.fg(role, text) : text;
  return {
    invalidate() { body.invalidate(); },
    render(columns) {
      const width = Number.isSafeInteger(columns) && columns > 0 ? columns : 1;
      const pad = Math.min(Number.isSafeInteger(outputPad) ? Math.max(0, outputPad) : 1, Math.max(0, Math.floor((width - 4) / 2)));
      const margin = ' '.repeat(pad), rail = width >= 4 ? '│ ' : '';
      const inner = Math.max(1, width - pad * 2 - rail.length);
      const line = (text, role) => truncateToWidth(`${margin}${color('accent', rail)}${role ? color(role, text) : text}`, width, '');
      const rows = [line(truncateToWidth(CARD_TITLE, inner), 'accent'), line(truncateToWidth(sender, inner), 'muted'), line('')];
      const bodyRows = body.render(inner);
      // Valid escaped text can wrap into hundreds of thousands of narrow rows.
      // Never spread those rows into a call (which exceeds JS argument limits).
      for (const text of expanded ? bodyRows : bodyRows.slice(0, COLLAPSED_BODY_LINES)) rows.push(line(text));
      if (expanded && details.length) {
        rows.push(line(''), line('Detalhes', 'dim'));
        for (const detail of details) for (const text of new Text(detail, 0, 0).render(inner)) rows.push(line(text, 'dim'));
      } else if (!expanded) {
        const remaining = Math.max(0, bodyRows.length - COLLAPSED_BODY_LINES);
        const hint = remaining ? `… mais ${remaining} linhas · expandir para ler tudo e detalhes` : 'Expandir para detalhes';
        rows.push(line(truncateToWidth(hint, inner), 'dim'));
      }
      return rows;
    },
  };
}
