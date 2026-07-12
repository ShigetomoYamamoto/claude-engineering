# Coding Security

秘密の基本衛生（ハードコード禁止・env 管理・add時ブロック層）は core foundation の `rules/secret-hygiene.md` を正とする。ここではコードレベルのセキュリティ観点のみ扱う。

## Mandatory Security Checks

Before ANY commit:
- [ ] All user inputs validated
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (sanitized HTML)
- [ ] CSRF protection enabled
- [ ] Authentication/authorization verified
- [ ] Rate limiting on all endpoints
- [ ] Error messages don't leak sensitive data

## Security Response Protocol

If security issue found:
1. STOP immediately
2. Use **security-reviewer** agent
3. Fix CRITICAL issues before continuing
4. Rotate any exposed secrets
5. Review entire codebase for similar issues
