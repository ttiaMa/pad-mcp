# Selected mode: PAD Classic (Power Fx disabled)

Use the Classic action/type editions. Do not introduce Power Fx expressions or $fx values.

Value syntax:
- Strings use $'''value'''; empty text is $''''''. Numbers and True/False are bare.
- Variables and expressions outside strings are bare: SET Total TO Price * Qty, IF Files.Count = 0 THEN, Row['Amount'].
- Percent interpolation belongs only inside strings, such as $'''Total %Total%'''. A literal percent inside a string is %%.
- Escape an apostrophe as \' inside strings. Double a backslash before interpolation or the closing quotes. UNC strings start with four backslashes. Follow the retrieved type examples for paths and escaping.
- Enums use exactly the fully qualified value shown by the selected action; outputs use Name=> Variable.
- Classic list indexing starts at zero. Do not transfer that rule to Excel row/column parameters or other APIs; consult the action/type reference.
- Use bracket access for keyword properties, such as Mail['From'].

Built-in flow forms (each statement on its own line):
- SET Variable TO value
- IF condition THEN ... ELSE IF condition THEN ... ELSE ... END
- SWITCH value ... CASE = 1 ... DEFAULT ... END; CASE takes a comparison.
- LOOP FOREACH item IN collection ... END
- LOOP index FROM 0 TO count - 1 STEP 1 ... END
- LOOP WHILE (Counter) < (Limit) ... END
- EXIT LOOP, NEXT LOOP, LABEL Name, GOTO Name, WAIT 5, EXIT Code: 0

Conditions use =, <>, >, <, >=, <=, AND, OR and documented predicates such as IsEmpty and Contains. For action conditions, use the catalog's exact wrapper rather than extrapolating a predicate.

Block error handling layout: BLOCK Name, ON BLOCK ERROR, SET Failed TO True, END, the protected actions, END. Per-action ON ERROR ... END follows its action. The common handler restrictions still apply.
