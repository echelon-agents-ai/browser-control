import type { Tool } from "./types";
import { tabs_context, tabs_create, tabs_close } from "./tabs";
import { navigate } from "./navigate";
import { screenshot } from "./screenshot";
import { read_page, find } from "./read_page";
import { click } from "./click";
import { type } from "./type";
import { javascript_eval, get_page_text } from "./eval";
import { file_upload } from "./file_upload";
import { form_input } from "./form_input";
import { scroll, hover } from "./scroll";
import { console_read, network_read, action_log } from "./logs";
import { handoff, handoff_status } from "./handoff";
import { batch } from "./batch";
import { mark_secret } from "./secret";
import { computer } from "./computer";
import { tabs_orphans } from "./orphans";
import { version } from "./version";

export const TOOLS: Record<string, Tool> = {
  tabs_context, tabs_create, tabs_close, navigate, screenshot, read_page,
  click, type, get_page_text, javascript_eval, file_upload,
  find, form_input, scroll, hover, console_read, network_read, action_log,
  handoff, handoff_status, batch, mark_secret, computer, tabs_orphans, version,
};
