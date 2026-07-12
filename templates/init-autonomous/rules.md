# init-autonomous テンプレート: .claude/rules/*（スタック別ルール）

> `/init-autonomous` のステップ4が読み込む生成テンプレート集。`{{ }}` を収集情報で
> 置換し、検出スタックに該当する分だけ生成する。元は `commands/init-autonomous.md` に
> 埋め込まれていたものを保守性のため外出し（ADR: テンプレート外出し / 要件 Issue #1）。

---

### 4-2. `.claude/rules/`

**共通（全スタック必須）:**

#### `.claude/rules/architecture.md`

採用したアーキテクチャパターンと責務分離のルールを記載する。検出したスタックに応じて内容を変える:

- Laravel が含まれる場合: Controller（HTTP処理のみ）→ Service（ビジネスロジック）→ Repository（DB操作）の3層構成を記載
- Next.js が含まれる場合: Server Components（データフェッチ）/ Client Components（インタラクション）/ Server Actions（フォーム送信）の分離を記載
- FastAPI / Django が含まれる場合: Router/View → Service → Repository の分離を記載
- 共通: 依存の方向（上位レイヤーが下位に依存、逆は禁止）を明記

#### `.claude/rules/testing.md`

テスト戦略を記載する:
- カバレッジ目標: 80% 以上
- TDD の手順（RED → GREEN → REFACTOR）
- テスト種別: 単体テスト・統合テスト・E2Eテスト
- `{{ TEST_FRAMEWORK }}` のコマンド例（カバレッジ付きで実行する方法）
- モックの使用方針（DBは原則モックしない、外部APIはモックする）

#### `.claude/rules/git-workflow.md`

ブランチ戦略とコミット形式を記載する:
- ブランチ命名: `feature/目的_YYYYMMDD`、`fix/目的_YYYYMMDD`
- コミットメッセージ: Conventional Commits 形式（`feat:` `fix:` `refactor:` `docs:` `test:` `chore:`）
- PR の作り方: `/create-pr` コマンドを使う
- ブランチ保護: `main` / `develop` への直接プッシュ禁止

**スタック別（検出したものだけ生成）:**

#### `.claude/rules/laravel.md`（Laravel 検出時）

```markdown
# Laravel ルール

## 責務分離

Controller はHTTPリクエスト/レスポンスのみ担当する。

**Good:**
\`\`\`php
class OrderController extends Controller
{
    public function store(StoreOrderRequest $request, OrderService $service): JsonResponse
    {
        $order = $service->create($request->validated());
        return response()->json(new OrderResource($order), 201);
    }
}
\`\`\`

**Bad:**
\`\`\`php
class OrderController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        // Controller にビジネスロジックを書かない
        $order = Order::create([...]);
        Mail::to($order->user)->send(new OrderConfirmation($order));
        return response()->json($order);
    }
}
\`\`\`

## Eloquent

- N+1 禁止: `with()` で Eager Load を明示する
- DB操作はトランザクションでラップする: `DB::transaction(fn() => ...)`
- `all()` 禁止: 必ず `where` か `paginate` を使う
```

#### `.claude/rules/nextjs.md`（Next.js 検出時）

```markdown
# Next.js ルール

## Server / Client Components の使い分け

データフェッチは Server Components で行う。

**Good:**
\`\`\`tsx
// app/orders/page.tsx — Server Component
export default async function OrdersPage() {
  const orders = await fetchOrders() // サーバーで実行
  return <OrderList orders={orders} />
}
\`\`\`

**Bad:**
\`\`\`tsx
'use client'
export default function OrdersPage() {
  const [orders, setOrders] = useState([])
  useEffect(() => { fetchOrders().then(setOrders) }, []) // クライアントフェッチは避ける
}
\`\`\`

## Server Actions

フォーム送信には Server Actions を使う。`api/` ルートは外部クライアント向けのみ。

## ルーティング

App Router を使用する。`pages/` ディレクトリへの新規追加は禁止。
```

#### `.claude/rules/django.md`（Django 検出時）

```markdown
# Django ルール

## 責務分離

View はHTTP処理のみ。ビジネスロジックは `services.py` に集約する。

**Good:**
\`\`\`python
# services.py
def create_order(user: User, data: dict) -> Order:
    with transaction.atomic():
        order = Order.objects.create(user=user, **data)
        send_confirmation_email(order)
        return order
\`\`\`

## ORM

- N+1 禁止: `select_related()` / `prefetch_related()` を明示する
- `all()` をそのまま使用禁止: フィルタまたはページネーションを必ず適用する
- DB操作は `transaction.atomic()` でラップする
```

#### `.claude/rules/typescript.md`（TypeScript 検出時）

```markdown
# TypeScript ルール

## 型定義

- `any` 禁止。型が不明な場合は `unknown` + 型ガードを使う
- 型定義の場所: `types/` ディレクトリ または各ドメインの `*.types.ts`

**Good:**
\`\`\`typescript
function parseResponse(data: unknown): ApiResponse {
  if (!isApiResponse(data)) throw new Error('Invalid response shape')
  return data
}
\`\`\`

**Bad:**
\`\`\`typescript
function parseResponse(data: any): any {
  return data
}
\`\`\`

## 非同期処理

`async/await` を使う。`.then().catch()` チェーンは避ける。
エラーは `try/catch` でハンドリングし、ユーザーフレンドリーなメッセージを投げる。
```

#### `.claude/rules/react.md`（React/Next.js 検出時）

```markdown
# React ルール

## コンポーネント設計

- 1コンポーネント = 1責務。200行を超えたら分割を検討する
- カスタムフックにロジックを分離する（`use` プレフィックス）

**Good:**
\`\`\`tsx
function useOrderForm(orderId: string) {
  const [state, dispatch] = useReducer(orderReducer, initialState)
  const submit = async (data: OrderFormData) => { ... }
  return { state, submit }
}

export function OrderForm({ orderId }: Props) {
  const { state, submit } = useOrderForm(orderId)
  return <form onSubmit={submit}>...</form>
}
\`\`\`

## 状態管理

- ローカル状態: `useState` / `useReducer`
- サーバー状態: TanStack Query または SWR
- グローバル状態: Context API（小規模）または Zustand（大規模）
- フォーム: React Hook Form + Zod バリデーション
```

#### `.claude/rules/vue.md`（Vue/Nuxt 検出時）

```markdown
# Vue ルール

## コンポーネント設計

- Composition API (`<script setup>`) を使う
- ロジックは `composables/use*.ts` に分離する
- Props は `defineProps` で型定義必須

## 状態管理

- Pinia を使う。Vuex は禁止
- ストアはドメイン単位で分割する（`useOrderStore`, `useUserStore` 等）
```

---

