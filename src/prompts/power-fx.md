# Selected mode: PAD with Power Fx enabled

Use the Power Fx action/type editions directly. Never convert Classic examples through mechanical string replacement. Follow the retrieved reference_rules.power_fx values, run_time_traps and kept_classic exceptions.

Value syntax:
- Text uses $fx'value'. Escape an apostrophe as \' and a literal backslash as \\; follow the retrieved example for paths. Do not double an apostrophe as a substitute for escaping it.
- Expressions begin with = inside $fx, for example $fx'=Price * Qty'. Text literals inside expressions use double quotes.
- Interpolate with ${...}, for example $fx'Saved ${Count} files'. A literal ${ is $${. A percent sign does not require Classic %% escaping.
- Text beginning with = is interpreted as an expression; represent a literal equals sign as $fx'="="'.
- Bare numbers, booleans, enums and variable names can be valid where the golden example uses them. Do not wrap every parameter in $fx indiscriminately.
- Names are case-sensitive. Initialize variables and use only Power Fx functions supported by the target PAD environment; IntelliSense or general Power Fx documentation alone does not establish support.
- For lists use CountRows(L) and Index(L, 1).Value as appropriate to the actual element type. Never use Classic L.Count or L[0]. Do not assume every record has a Value field.
- List/table action indices are one-based in this catalog; text positions remain zero-based. Excel rows/columns are one-based. Consult each action rather than applying a universal index conversion.
- Files, folders and errors are records: interpolate an appropriate field such as ${File.FullName} or ${LastError.Message}, not the whole record. Handle untyped values and conversions explicitly when required.

Built-in flow forms (each statement on its own line):
- SET Total TO $fx'=Price * Qty'
- IF $fx'=N > 3' THEN ... ELSE ... END
- LOOP FOREACH item IN $fx'=Items' ... END
- LOOP i FROM $fx'=1' TO $fx'=CountRows(Items)' STEP $fx'=1' ... END
- WAIT $fx'=2'

Use catalog examples for action-based conditions and loops. Do not generate SWITCH/CASE in Power Fx flows. Use IF/ELSE branches instead. Do not assume other unlisted forms work in the target Power Fx flow without compatible verified evidence.

Block error handling layout: BLOCK Name, ON BLOCK ERROR, SET Failed TO $fx'=true', END, the protected actions, END. Per-action ON ERROR ... END follows an action that supports errors. Some expression/load failures are not caught by these handlers. A cloud-triggered incompatible-PowerFx-version message can indicate a load error; inspect PAD's RobinEngine logs instead of assuming a version mismatch. Validate new compositions with real inputs in a test flow, including cloud invocation when that is the intended deployment.
