You are writing an evaluation benchmark that measures how well an AI assistant
answers a new hire's practical questions about a company's data.

You will be given a JSON description of that company's data assets, read
directly out of the company's metadata system. It lists tables and views, their
columns and types, written descriptions, the people recorded as owners,
business-glossary terms attached to each asset, tags, business domains, and
which assets feed which. That JSON is the ground truth. It is the only thing you
know about this company.

Write **20 questions** a person joining this data team would genuinely ask in
their first week, and for each one, mechanical checks that decide whether an
answer is right.

## How the checks work

Each check is a **case-insensitive substring match** against the assistant's
final answer. Whitespace is collapsed and markdown emphasis is stripped before
matching, so `**orders**` matches `orders`.

- `mustInclude` is a list of groups. A group passes if **any one** of its
  alternatives appears in the answer. Use the alternatives for legitimate ways
  of writing the same fact — a table's short name and its full identifier, a
  person's display name and their username.
- `mustNotInclude` is a list of groups. A group fails if **any** of its
  alternatives appears. Use it for the specific wrong answers a confident
  assistant would produce: a plausible table name that does not exist here, a
  person who does not work on this data, a column invented to make a query look
  complete.
- A case passes only if **every** group passes. There is no partial credit.

## Rules

1. **Every `mustInclude` alternative must be a fact you can point to in the
   JSON**, or an unambiguous phrase for a fact in the JSON. Do not require a
   number, a date, a system or a person that is not there. A check whose answer
   key is wrong measures nothing.
2. **Every `mustNotInclude` alternative must NOT appear anywhere in the JSON.**
   If you list a wrong table name, make sure it is genuinely absent, or you will
   fail correct answers.
3. **Keep the phrasing of the question natural.** Write what a person would type
   into a chat window, not a database query specification. They do not know the
   table names yet — that is why they are asking.
4. **Do not write only questions that are easy to answer.** Include some where
   the honest answer is that this information is not recorded anywhere in the
   JSON, and the assistant is supposed to say so plainly rather than invent it.
   Check that with a `mustNotInclude` group listing the inventions it would
   reach for.
5. **Cover a spread.** Finding the right asset among similar ones; who to ask
   about something; what a business term means here; where a number comes from;
   what feeds what; writing a first query against a real table; and the traps
   above where the record is silent.
6. **Do not write questions to suit any particular assistant.** You do not know
   what tool, model or data access the assistant being measured has. Write what
   would be a fair test of anyone claiming to help a new hire, including
   questions you expect a good assistant to get wrong.

## Output format

Return **only** a JSON array of 20 objects, no prose around it, no markdown
fence. Each object:

```json
{
  "id": "short-kebab-case-identifier",
  "category": "one of: finding-the-right-asset | who-to-ask | business-terms | where-numbers-come-from | what-feeds-what | writing-a-query | not-recorded",
  "question": "the question, as a person would type it",
  "stakes": "one sentence on what getting this wrong costs the team",
  "mustInclude": [{ "label": "what this check is for", "anyOf": ["alternative", "alternative"] }],
  "mustNotInclude": [{ "label": "what this check rules out", "anyOf": ["wrong thing", "wrong thing"] }]
}
```

`mustNotInclude` may be omitted where nothing specific is worth ruling out.
