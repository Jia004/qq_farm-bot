import { useStorage } from '@vueuse/core'
import axios from 'axios'
import NProgress from 'nprogress'
import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { menuRoutes } from './menu'
import 'nprogress/nprogress.css'

NProgress.configure({ showSpinner: false })

const adminToken = useStorage('admin_token', '')
let validatedToken = ''
let validatingPromise: Promise<boolean> | null = null
let autoLoginPromise: Promise<boolean> | null = null

// 免登录：本机/局域网来源自动以管理员身份登录（后端校验来源 IP）
// 失败（如公网/非信任来源/无管理员）时返回 false，走正常登录页。
async function tryAutoLogin() {
  if (adminToken.value) return true
  if (autoLoginPromise) return autoLoginPromise
  autoLoginPromise = axios.post('/api/auto-login', {}, {
    timeout: 6000,
  }).then((res) => {
    const ok = !!(res.data && res.data.ok && res.data.data && res.data.data.token)
    if (ok) {
      adminToken.value = res.data.data.token
      validatedToken = res.data.data.token
      const userStore = useUserStore()
      userStore.fetchUserInfo().catch(() => {})
    }
    return ok
  }).catch(() => false).finally(() => {
    autoLoginPromise = null
  })
  return autoLoginPromise
}

async function ensureTokenValid() {
  const token = String(adminToken.value || '').trim()
  if (!token)
    return false

  if (validatedToken && validatedToken === token)
    return true

  if (validatingPromise)
    return validatingPromise

  validatingPromise = axios.get('/api/auth/validate', {
    headers: { 'x-admin-token': token },
    timeout: 6000,
  }).then((res) => {
    const ok = !!(res.data && res.data.ok)
    if (ok) {
      validatedToken = token
      const userStore = useUserStore()
      userStore.fetchUserInfo().catch(() => {})
    }
    return ok
  }).catch(() => false).finally(() => {
    validatingPromise = null
  })

  return validatingPromise
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: () => import('@/layouts/DefaultLayout.vue'),
      children: menuRoutes.map(route => ({
        path: route.path,
        name: route.name,
        component: route.component,
      })),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/Login.vue'),
    },
    {
      path: '/renewal',
      name: 'renewal',
      component: () => import('@/views/Renewal.vue'),
    },
  ],
})

router.beforeEach(async (to) => {
  NProgress.start()

  if (to.name === 'renewal') {
    if (!adminToken.value) {
      validatedToken = ''
      return true
    }
    const valid = await ensureTokenValid()
    if (!valid) {
      adminToken.value = ''
      validatedToken = ''
    }
    return true
  }

  if (to.name === 'login') {
    if (!adminToken.value) {
      validatedToken = ''
      // 本机/局域网免登录：能自动登录就直接进首页，不再展示登录页
      const autoOk = await tryAutoLogin()
      if (autoOk) return { name: 'dashboard' }
      return true
    }
    const valid = await ensureTokenValid()
    if (valid)
      return { name: 'dashboard' }
    adminToken.value = ''
    validatedToken = ''
    const autoOk = await tryAutoLogin()
    if (autoOk) return { name: 'dashboard' }
    return true
  }

  if (!adminToken.value) {
    validatedToken = ''
    // 本机/局域网免登录：先尝试自动登录，成功直接进目标页
    const autoOk = await tryAutoLogin()
    if (autoOk) return true
    return { name: 'login' }
  }

  const valid = await ensureTokenValid()
  if (!valid) {
    adminToken.value = ''
    validatedToken = ''
    // 本机/局域网免登录：token 失效时先尝试自动登录
    const autoOk = await tryAutoLogin()
    if (autoOk) return true
    return { name: 'login' }
  }

  return true
})

router.afterEach(() => {
  NProgress.done()
})

export default router
