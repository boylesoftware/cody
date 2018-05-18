'use strict';

const gulp = require('gulp');
const gulpLoadPlugins = require('gulp-load-plugins');

const plugins = gulpLoadPlugins();

function assembleLambda(pkg) {

	return gulp
		.src([
			`./lambda/${pkg}/**/*.js`,
			`./lambda/${pkg}/package*.json`,
			`!./lambda/${pkg}/node_modules/**`
		])
		.pipe(gulp.dest(`./build/lambda/${pkg}`))
		.pipe(plugins.install({
			production: true
		}));
}

function packageLambda(pkg) {

	return gulp
		.src(`./build/lambda/${pkg}/**/*`)
		.pipe(plugins.zip(`cody-${pkg}.zip`))
		.pipe(gulp.dest('./build'));
}

gulp.task('assemble-commit-handler', () => assembleLambda('commit-handler'));
gulp.task('package-commit-handler', [ 'assemble-commit-handler' ], () => packageLambda('commit-handler'));
gulp.task('assemble-publisher', () => assembleLambda('publisher'));
gulp.task('package-publisher', [ 'assemble-publisher' ], () => packageLambda('publisher'));

gulp.task('default', [ 'package-commit-handler', 'package-publisher' ]);
