# Coding Style

## Immutability (CRITICAL)

ALWAYS create new values, NEVER mutate existing ones. Use language-appropriate immutable patterns to derive new state.

## File Organization

MANY SMALL FILES > FEW LARGE FILES:
- High cohesion, low coupling
- 200-400 lines typical, 800 max
- Extract utilities from large modules
- Organize by feature/domain, not by type

## Code Quality Checklist

Before marking work complete:
- [ ] Code is readable and well-named
- [ ] Functions are small (<50 lines)
- [ ] Files are focused (<800 lines)
- [ ] No deep nesting (>4 levels)
- [ ] Proper error handling
- [ ] No debug output statements left in code
- [ ] No hardcoded values
- [ ] No mutation (immutable patterns used)
