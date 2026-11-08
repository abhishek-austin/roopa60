/* prompts.js — the configurable prompt bank.
 *
 * Add, remove or reword prompts here. IDs are referenced from guests.js and
 * from personalised links (?q=1,4,5), so keep existing IDs stable.
 * DEFAULT_PROMPT_IDS is used for guests with no configured prompts.
 */
const PROMPTS = [
  { id: 1, text: "Describe Roopa in one word — and why?" },
  { id: 2, text: "What is one Roopa memory you’ll never forget?" },
  { id: 3, text: "What is your wish for Roopa at 60?" },
  { id: 4, text: "What is the funniest thing about Roopa?" },
  { id: 5, text: "What is something Roopa has done for you that she may not realize mattered?" },
  { id: 6, text: "What food or dish immediately makes you think of Roopa?" },
  { id: 7, text: "What is the most adventurous thing you’ve seen Roopa do?" },
  { id: 8, text: "If Roopa could travel anywhere tomorrow, where should she go?" }
];

const DEFAULT_PROMPT_IDS = [1, 2, 3];
