import {themes as prismThemes} from 'prism-react-renderer';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: '교육 자료실',
  tagline: '강의 문서와 실습 자료를 한곳에서 확인하세요.',
  favicon: 'img/favicon.svg',
  url: process.env.SITE_URL || 'http://localhost',
  baseUrl: '/',
  organizationName: 'HyeonseongKim99',
  projectName: 'EducationWebPage',
  onBrokenLinks: 'throw',
  i18n: {
    defaultLocale: 'ko',
    locales: ['ko'],
  },
  presets: [
    [
      'classic',
      {
        docs: {
          path: 'generated/docs',
          routeBasePath: 'courses',
          sidebarPath: false,
          breadcrumbs: true,
          showLastUpdateTime: false,
          showLastUpdateAuthor: false,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      },
    ],
  ],
  themeConfig: {
    navbar: {
      title: '교육 자료실',
      logo: {alt: '교육 자료실', src: 'img/logo.svg'},
      items: [
        {to: '/courses/', label: '수업 목록', position: 'left'},
        {
          href: 'https://github.com/HyeonseongKim99/EducationWebPage',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: '바로가기',
          items: [{label: '수업 목록', to: '/courses/'}],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} 교육 자료실`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'python', 'java', 'c', 'cpp'],
    },
    colorMode: {
      defaultMode: 'light',
      respectPrefersColorScheme: true,
    },
  },
};

export default config;
