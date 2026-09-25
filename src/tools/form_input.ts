import { assertOwned } from "../tabs";
import { BueError } from "../protocol";
import type { Tool } from "./types";
import { callOnRef, resolveRef, IS_SECRET_FIELD_FN } from "./util";
import { markValueLoggable, markSecretTarget } from "../actionlog";
import { markVaultFilled } from "../mask";

const SET_VALUE_FN = `function(v){
  const el = this;
  const tag = el.tagName;
  const fire = () => { el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); };
  if (tag === 'SELECT') {
    const want = String(v);
    const opt = [...el.options].find(o => o.value === want) || [...el.options].find(o => o.text.trim() === want);
    if (!opt) throw new Error('no matching option in select; have: ' + [...el.options].map(o => o.value).join(', '));
    el.value = opt.value; fire();
    return {tag, value: el.value};
  }
  if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
    const on = v === true || v === 'true' || v === 'on' || v === 1 || v === 'checked';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set.call(el, on); fire();
    return {tag, type: el.type, checked: el.checked};
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v)); fire();
    return {tag, type: el.type, length: el.value.length};
  }
  if (el.isContentEditable) { el.textContent = String(v); fire(); return {tag, contentEditable: true}; }
  throw new Error('ref is not a form field (' + tag + ')');
}`;

/** args: {tabId, ref, value, secret?} — secret:true marks the field vault-filled (always masked in captures).  select (by value or text), checkbox/radio (boolean), text/textarea/contenteditable. */
export const form_input: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  if (args.value === undefined) throw new BueError("BAD_REQUEST", "form_input needs args.value");
  const secretField = await callOnRef<boolean>(tab.id!, args.ref, IS_SECRET_FIELD_FN);
  const vault = args.secret === true;
  if (vault) {
    const { target, backendNodeId } = resolveRef(tab.id!, args.ref);
    await markVaultFilled(target, backendNodeId);
  }
  if (secretField || vault) markSecretTarget(args);
  else markValueLoggable(args);
  const r = await callOnRef<Record<string, unknown>>(tab.id!, args.ref, SET_VALUE_FN, [args.value]);
  // Never echo a value back: a select's chosen value is only returned for non-secret fields.
  if (secretField || vault) delete r.value;
  return { set: r };
};
