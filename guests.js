/* guests.js — personalised guest configuration.
 *
 * Key   = the slug used in the link:  https://roopa60.theanbgroup.com/?guest=ravi-shah
 * Value = who they are and which prompt IDs (from prompts.js) they should get.
 *
 * A ?q=1,4,5 parameter in the URL always overrides `prompts` below.
 * Guests not listed here are asked for their first and last name and get the
 * default prompts — unless the link carries fn/ln/rel parameters, which the
 * admin link generator (/?admin=1) adds so you never have to edit this file.
 */
const GUESTS = {
  "ravi-shah": {
    firstName: "Ravi",
    lastName: "Shah",
    displayName: "Ravi",
    relationship: "Family Friend",
    prompts: [1, 2, 3]
  },

  "janany": {
    firstName: "Janany",
    lastName: "Balakrishnan",
    displayName: "Janany",
    relationship: "Family",
    prompts: [1, 5, 3]
  }
};
