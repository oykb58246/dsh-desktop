const nav = document.querySelector('.main-nav')
const menuToggle = document.querySelector('.menu-toggle')
const toast = document.querySelector('.toast')
let toastTimer

function showToast(message) {
  window.clearTimeout(toastTimer)
  toast.textContent = message
  toast.classList.add('is-visible')
  toastTimer = window.setTimeout(() => {
    toast.classList.remove('is-visible')
  }, 2800)
}

menuToggle?.addEventListener('click', () => {
  const isOpen = nav.classList.toggle('is-open')
  menuToggle.setAttribute('aria-expanded', String(isOpen))
})

nav?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    nav.classList.remove('is-open')
    menuToggle?.setAttribute('aria-expanded', 'false')
  })
})

document.querySelectorAll('[data-download]').forEach((link) => {
  link.addEventListener('click', () => {
    showToast(`正在打开 ${link.dataset.download} 本地下载列表…`)
  })
})
