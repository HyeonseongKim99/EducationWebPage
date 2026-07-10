import clsx from 'clsx';
import Heading from '@theme/Heading';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import courses from '@site/generated/courses.json';
import styles from './index.module.css';

function CourseCard({course}) {
  return (
    <article className="course-card">
      <span className="course-badge">
        {course.access === 'protected' ? '🔒 비밀번호 필요' : '공개 수업'}
      </span>
      <Heading as="h2">{course.title}</Heading>
      <p>{course.description}</p>
      <Link className="button button--primary button--sm" to={`/courses/${course.slug}/`}>
        수업 들어가기
      </Link>
    </article>
  );
}

export default function Home() {
  return (
    <Layout title="홈" description="강의 문서와 실습 자료를 제공하는 교육 자료실">
      <header className={clsx('hero hero--primary', styles.hero)}>
        <div className="container">
          <Heading as="h1" className="hero__title">교육 자료실</Heading>
          <p className="hero__subtitle">강의 문서, 배포 자료, 실습 코드를 안전하게 제공합니다.</p>
          <Link className="button button--secondary button--lg" to="/courses/">
            수업 목록 보기
          </Link>
        </div>
      </header>
      <main className="container margin-vert--lg">
        <Heading as="h1">현재 수업</Heading>
        {courses.length === 0 ? (
          <p>등록된 수업이 없습니다. NAS의 courses 디렉터리에 수업을 추가해 주세요.</p>
        ) : (
          <div className="course-grid">
            {courses.map((course) => <CourseCard key={course.slug} course={course} />)}
          </div>
        )}
      </main>
    </Layout>
  );
}
