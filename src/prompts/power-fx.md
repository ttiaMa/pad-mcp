# Selected mode: PAD with Power Fx enabled

Use the Power Fx action/type editions directly. Never convert Classic examples through mechanical string replacement. Follow this context's catalog rules, including run_time_traps and kept_classic exceptions.

Use only Power Fx functions supported by the target PAD environment; IntelliSense alone does not establish support. Handle untyped values and conversions explicitly. Do not assume every list record has a Value field.

Built-in flow forms (each statement on its own line):
- SET Total TO $fx'=Price * Qty'
- IF $fx'=N > 3' THEN ... ELSE ... END
- LOOP FOREACH item IN $fx'=Items' ... END
- LOOP i FROM $fx'=1' TO $fx'=CountRows(Items)' STEP $fx'=1' ... END
- WAIT $fx'=2'

Use catalog examples for action-based conditions and loops. Do not generate SWITCH/CASE in Power Fx flows. Use IF/ELSE branches instead. Do not assume other unlisted forms work in the target Power Fx flow without compatible verified evidence.

Block error handling layout: BLOCK Name, ON BLOCK ERROR, SET Failed TO $fx'=true', END, the protected actions, END. Per-action ON ERROR ... END follows an action that supports errors. Validate new compositions with real inputs in a test flow, including cloud invocation when that is the intended deployment.
