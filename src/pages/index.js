import clsx from 'clsx';
import Heading from '@theme/Heading';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import courses from '@site/generated/courses.json';
import styles from './index.module.css';

function CourseCard({course, completed = false}) {
  const period = [course.availableFrom, course.availableUntil]
    .map((value) => value ? new Intl.DateTimeFormat('ko-KR', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Seoul',
    }).format(new Date(value)) : null);

  return (
    <article className={clsx('course-card', completed && 'course-card--completed')}>
      <div className="course-card__top">
        <span className="course-badge">
          {completed ? '✅ 교육 완료' : course.access === 'protected' ? '🔒 비밀번호 필요' : '공개 수업'}
        </span>
        {completed ? (
          <a className="button button--secondary button--sm" href={`/status/${course.slug}`}>
            종료 정보
          </a>
        ) : course.access === 'protected' ? (
          <a className="button button--primary button--sm" href={`/enter/${course.slug}`}>
            수업 들어가기
          </a>
        ) : (
          <Link className="button button--primary button--sm" to={`/courses/${course.slug}/`}>
            수업 들어가기
          </Link>
        )}
      </div>
      <Heading as="h2">{course.title}</Heading>
      <p>{course.description}</p>
      {(period[0] || period[1]) && (
        <p className="course-period">
          배포 기간: {period[0] || '제한 없음'} ~ {period[1] || '제한 없음'}
        </p>
      )}
    </article>
  );
}

export default function Home() {
  const currentCourses = courses.filter((course) => course.status !== 'completed');
  const completedCourses = courses.filter((course) => course.status === 'completed');
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
        <Heading as="h1">교육 세션</Heading>
        {currentCourses.length === 0 ? (
          <p>현재 진행 중이거나 예정된 교육 세션이 없습니다.</p>
        ) : (
          <div className="course-grid">
            {currentCourses.map((course) => <CourseCard key={course.slug} course={course} />)}
          </div>
        )}
        <section className="completed-courses">
          <Heading as="h2">완료된 교육 세션</Heading>
          {completedCourses.length === 0 ? (
            <p>완료된 교육 세션이 없습니다.</p>
          ) : (
            <div className="course-grid">
              {completedCourses.map((course) => <CourseCard key={course.slug} course={course} completed />)}
            </div>
          )}
        </section>
      </main>
    </Layout>
  );
}
