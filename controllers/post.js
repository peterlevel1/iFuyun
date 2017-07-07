/**
 * 文章
 * @author fuyun
 * @since 2017/04/12
 */
const fs = require('fs');
const path = require('path');
const async = require('async');
const moment = require('moment');
const url = require('url');
const xss = require('sanitizer');
const formidable = require('formidable');
const models = require('../models/index');
const common = require('./common');
const appConfig = require('../config/core');
const util = require('../helper/util');
const formatter = require('../helper/formatter');
const logger = require('../helper/logger').sysLog;
const idReg = /^[0-9a-fA-F]{16}$/i;
const pagesOut = 9;
const {Post, User} = models;

/**
 * 查询公共数据
 * @param {Object} param 参数对象
 * @param {Function} cb 回调函数
 * @return {*} null
 */
function getCommonData(param, cb) {
    // 执行时间在30-60ms，间歇60-80ms
    async.parallel({
        archiveDates: (cb) => {
            common.archiveDates(cb, param.postType || 'post');
        },
        recentPosts: common.recentPosts,
        randPosts: common.randPosts,
        hotPosts: common.hotPosts,
        friendLinks: (cb) => common.getLinks('friendlink', param.from !== 'list' || param.page > 1 ? 'site' : ['homepage', 'site'], cb),
        quickLinks: (cb) => common.getLinks('quicklink', ['homepage', 'site'], cb),
        categories: common.getCategoryTree.bind(common),
        mainNavs: common.mainNavs,
        options: common.getInitOptions
    }, function (err, result) {
        if (err) {
            cb(err);
        } else {
            cb(null, result);
        }
    });
}

/**
 * 根据IDs查询post
 * @param {Object} posts post对象数组
 * @param {Array} postIds post id数组
 * @param {Function} cb 回调函数
 * @return {*} null
 */
function queryPostsByIds(posts, postIds, cb) {
    // 执行时间在10-20ms
    /**
     * 根据group方式去重（distinct需要使用子查询，sequelize不支持include时的distinct）
     * 需要注意的是posts和postsCount的一致性
     * 评论数的查询通过posts进行循环查询，采用关联查询会导致结果不全（hasMany关系对应的是INNER JOIN，并不是LEFT OUTER JOIN），且并不需要所有评论数据，只需要总数
     *
     * sequelize有一个Bug：
     * 关联查询去重时，通过group by方式无法获取关联表的多行数据（如：此例的文章分类，只能返回第一条，并没有返回所有的分类）*/
    models.TermTaxonomy.findAll({
        attributes: ['taxonomyId', 'taxonomy', 'name', 'slug', 'description', 'parent', 'count'],
        include: [{
            model: models.TermRelationship,
            attributes: ['objectId', 'termTaxonomyId'],
            where: {
                objectId: postIds
            }
        }],
        where: {
            taxonomy: ['post', 'tag']
        },
        order: [['termOrder', 'asc']]
    }).then((data) => {
        let result = [];
        posts.forEach((post) => {
            let tags = [];
            let categories = [];
            data.forEach((u) => {
                if (u.taxonomy === 'tag') {
                    u.TermRelationships.forEach((v) => {
                        if (v.objectId === post.postId) {
                            tags.push(u);
                        }
                    });
                } else {
                    u.TermRelationships.forEach((v) => {
                        if (v.objectId === post.postId) {
                            categories.push(u);
                        }
                    });
                }
            });
            result.push({
                post,
                tags,
                categories
            });
        });
        cb(null, result);
    });
}

/**
 * 查询posts
 * @param {Object} param 参数对象
 * @param {Function} cb 回调函数
 * @return {*} null
 */
function queryPosts(param, cb) {
    let queryOpt = {
        where: param.where,
        attributes: [
            'postId', 'postTitle', 'postDate', 'postContent', 'postExcerpt', 'postStatus',
            'commentFlag', 'postOriginal', 'postName', 'postAuthor', 'postModified', 'postCreated', 'postGuid', 'commentCount', 'postViewCount'
        ],
        include: [{
            model: User,
            attributes: ['userDisplayName']
        }],
        order: [['postCreated', 'desc'], ['postDate', 'desc']],
        limit: 10,
        offset: 10 * (param.page - 1),
        subQuery: false
    };
    switch (param.from) {
        case 'category':
            queryOpt.include = queryOpt.include.concat(param.includeOpt);
            queryOpt.group = ['postId'];
            break;
        case 'tag':
            queryOpt.include = queryOpt.include.concat(param.includeOpt);
            break;
        default:
    }
    Post.findAll(queryOpt).then((posts) => {
        let postIds = [];
        posts.forEach((v) => postIds.push(v.postId));
        queryPostsByIds(posts, postIds, cb);
    });
}

/**
 * post保存校验
 * @param {Object} data 数据
 * @param {String} type post类型
 * @param {Array} postCategory 分类数组
 * @param {Array} postTag 标签数组
 * @return {*} null
 */
function checkPostFields({data, type, postCategory, postTag}) {
    // TODO: postGuid:/page-,/post/page-,/category/,/archive/,/tag/,/comment/,/user/,/admin/,/post/comment/
    let rules = [{
        rule: !data.postTitle,
        message: '标题不能为空'
    }, {
        rule: !data.postContent,
        message: '内容不能为空'
    }, {
        rule: !data.postStatus,
        message: '状态不能为空'
    }, {
        rule: data.postStatus === 'password' && !data.postPassword,
        message: '密码不能为空'
    }];
    if (type === 'post') {
        rules = rules.concat([{
            rule: !postCategory || postCategory.length < 1,
            message: '目录不能为空'
        }, {
            rule: postCategory.length > 5,
            message: '目录数应不大于5个'
        }, {
            rule: postTag.length > 10,
            message: '标签数应不大于10个'
        }]);
    } else {
        rules.push({
            rule: !data.postGuid,
            message: 'URL不能为空'
        });
    }
    for (let i = 0; i < rules.length; i += 1) {
        if (rules[i].rule) {
            return util.catchError({
                status: 200,
                code: 400,
                message: rules[i].message
            });
        }
    }
    return true;
}

module.exports = {
    listPosts: function (req, res, next) {
        let page = parseInt(req.params.page, 10) || 1;
        let where = {
            postStatus: 'publish',
            postType: 'post'
        };
        if (req.query.keyword) {
            where.$or = [{
                postTitle: {
                    $like: `%${req.query.keyword}%`
                }
            }, {
                postContent: {
                    $like: `%${req.query.keyword}%`
                }
            }, {
                postExcerpt: {
                    $like: `%${req.query.keyword}%`
                }
            }];
        }
        async.auto({
            commonData: (cb) => {
                getCommonData({
                    page,
                    from: 'list'
                }, cb);
            },
            postsCount: (cb) => {
                Post.count({
                    where
                }).then((result) => cb(null, result));
            },
            posts: ['postsCount', (result, cb) => {
                page = (page > result.postsCount / 10 ? Math.ceil(result.postsCount / 10) : page) || 1;
                queryPosts({
                    page,
                    where,
                    from: 'index'
                }, cb);
            }],
            comments: ['posts', (result, cb) => common.getCommentCountByPosts(result.posts, cb)]
        }, function (err, result) {
            if (err) {
                return next(err);
            }
            let resData = {
                curNav: 'index',
                showCrumb: false,
                meta: {}
            };
            const options = result.commonData.options;
            Object.assign(resData, result.commonData);

            resData.posts = result.posts;
            resData.posts.paginator = util.paginator(page, Math.ceil(result.postsCount / 10), pagesOut);
            resData.posts.linkUrl = '/post/page-';
            resData.posts.linkParam = req.query.keyword ? '?keyword=' + req.query.keyword : '';
            resData.comments = result.comments;

            if (req.query.keyword) {
                if (page > 1) {
                    resData.meta.title = util.getTitle([req.query.keyword, '第' + page + '页', '搜索结果', options.site_name.optionValue]);
                } else {
                    resData.meta.title = util.getTitle([req.query.keyword, '搜索结果', options.site_name.optionValue]);
                }
            } else {
                if (page > 1) {
                    resData.meta.title = util.getTitle(['第' + page + '页', '文章列表', options.site_name.optionValue]);
                } else {
                    resData.meta.title = util.getTitle(['爱生活，爱抚云', options.site_name.optionValue]);
                }
            }

            resData.meta.description = (page > 1 ? '[文章列表](第' + page + '页)' : '') + options.site_description.optionValue;
            resData.meta.keywords = options.site_keywords.optionValue;
            resData.meta.author = options.site_author.optionValue;

            resData.util = util;
            resData.moment = moment;
            res.render(`${appConfig.pathViews}/front/pages/postList`, resData);
        });
    },
    showPost: function (req, res, next) {
        const postId = req.params.postId;
        if (!postId || !/^[0-9a-fA-F]{16}$/i.test(postId)) {// 不能抛出错误，有可能是/page
            return next();
        }
        async.auto({
            commonData: (cb) => {
                getCommonData({
                    from: 'post'
                }, cb);
            },
            post: function (cb) {
                Post.findById(postId, {
                    attributes: [
                        'postId', 'postTitle', 'postDate', 'postContent', 'postExcerpt', 'postStatus',
                        'commentFlag', 'postOriginal', 'postName', 'postAuthor', 'postModified', 'postCreated',
                        'postGuid', 'commentCount', 'postViewCount'
                    ],
                    include: [{
                        model: User,
                        attributes: ['userDisplayName']
                    }, {
                        model: models.TermTaxonomy,
                        attributes: ['taxonomyId', 'taxonomy', 'name', 'slug', 'description', 'parent', 'termOrder', 'count'],
                        where: {
                            taxonomy: ['post', 'tag']
                        }
                    }]
                }).then(function (post) {
                    if (!post || !post.postId) {
                        logger.error(util.getErrorLog({
                            req: req,
                            funcName: 'showPost',
                            funcParam: {
                                postId: post.postId
                            },
                            msg: 'Post Not Exist.'
                        }));
                        return cb(util.catchError({
                            status: 404,
                            code: 404,
                            message: 'Page Not Found.'
                        }));
                    }
                    // 无管理员权限不允许访问非公开文章(包括草稿)
                    if (!util.isAdminUser(req) && post.postStatus !== 'publish') {
                        logger.warn(util.getErrorLog({
                            req: req,
                            funcName: 'showPost',
                            funcParam: {
                                postId: post.postId,
                                postTitle: post.postTitle,
                                postStatus: post.postStatus
                            },
                            msg: post.postTitle + ' is ' + post.postStatus
                        }));
                        return cb(util.catchError({
                            status: 404,
                            code: 404,
                            message: 'Page Not Found.'
                        }));
                    }
                    cb(null, post);
                });
            },
            comments: ['post', (result, cb) => common.getCommentsByPostId(result.post.postId, cb)],
            crumb: ['commonData', 'post',
                function (result, cb) {
                    let post = result.post;
                    let categories = [];
                    post.TermTaxonomies.forEach((v) => {
                        if (v.taxonomy === 'post') {
                            categories.push(v);
                        }
                    });
                    if (categories.length < 1) {
                        logger.error(util.getErrorLog({
                            req: req,
                            funcName: 'showPost',
                            funcParam: {
                                postId: post.postId,
                                postTitle: post.postTitle
                            },
                            msg: 'Category Not Exist.'
                        }));
                        return cb('Category Not Exist.');
                    }
                    cb(null, common.getCategoryPath({
                        catData: result.commonData.categories.catData,
                        taxonomyId: categories[0].taxonomyId
                    }));
                }],
            prevPost: (cb) => common.getPrevPost(postId, cb),
            nextPost: (cb) => common.getNextPost(postId, cb)
        }, function (err, result) {
            if (err) {
                if (err.code === 404) {
                    return next();
                }
                return next(err);
            }
            let resData = {
                showCrumb: true,
                user: {},
                meta: {},
                token: req.csrfToken()
            };
            if (req.session.user) {
                resData.user.userName = req.session.user.userDisplayName;
                resData.user.userEmail = req.session.user.userEmail;
            }
            const options = result.commonData.options;
            Object.assign(resData, result.commonData);

            resData.curNav = result.crumb[0].slug;
            resData.curPos = util.createCrumb(result.crumb);
            resData.postCats = [];
            resData.postTags = [];

            let keywords = [];
            result.post.TermTaxonomies.forEach((v) => {
                if (v.taxonomy === 'tag') {
                    keywords.push(v.name);
                    resData.postTags.push(v);
                } else if (v.taxonomy === 'post') {
                    resData.postCats.push(v);
                }
            });
            keywords.push(options.site_keywords.optionValue);

            resData.meta.title = util.getTitle([result.post.postTitle, options.site_name.optionValue]);
            resData.meta.description = result.post.postExcerpt || util.cutStr(util.filterHtmlTag(result.post.postContent), 140);
            resData.meta.keywords = keywords.join(',') + ',' + options.site_keywords.optionValue;
            resData.meta.author = options.site_author.optionValue;
            resData.post = result.post;
            resData.prevPost = result.prevPost;
            resData.nextPost = result.nextPost;
            resData.comments = result.comments;
            resData.util = util;
            resData.moment = moment;
            res.render(`${appConfig.pathViews}/front/pages/post`, resData);
        });
    },
    showPage: function (req, res, next) {
        const reqUrl = url.parse(req.url);
        const reqPath = reqUrl.pathname;
        async.auto({
            commonData: (cb) => {
                getCommonData({
                    from: 'page',
                    postType: 'page'
                }, cb);
            },
            post: function (cb) {
                Post.findOne({
                    attributes: [
                        'postId', 'postTitle', 'postDate', 'postContent', 'postExcerpt', 'postStatus',
                        'commentFlag', 'postOriginal', 'postName', 'postAuthor', 'postModified', 'postCreated', 'postGuid', 'commentCount', 'postViewCount'
                    ],
                    include: [{
                        model: User,
                        attributes: ['userDisplayName']
                    }],
                    where: {
                        postGuid: decodeURIComponent(reqPath)
                    }
                }).then(function (result) {
                    if (!result || !result.postId) {
                        logger.error(util.getErrorLog({
                            req: req,
                            funcName: 'showPage',
                            funcParam: {
                                pageUrl: reqPath
                            },
                            msg: 'Post Not Exist.'
                        }));
                        return cb(util.catchError({
                            status: 404,
                            code: 404,
                            message: 'Page Not Found.'
                        }));
                    }
                    // 无管理员权限不允许访问非公开文章(包括草稿)
                    if (!util.isAdminUser(req) && result.postStatus !== 'publish') {
                        logger.warn(util.getErrorLog({
                            req: req,
                            funcName: 'showPage',
                            funcParam: {
                                postId: result.postId,
                                postTitle: result.postTitle,
                                postStatus: result.postStatus
                            },
                            msg: result.postTitle + ' is ' + result.postStatus
                        }));
                        return cb(util.catchError({
                            status: 404,
                            code: 404,
                            message: 'Page Not Found.'
                        }));
                    }
                    cb(null, result);
                });
            },
            comments: ['post', (result, cb) => common.getCommentsByPostId(result.post.postId, cb)]
        }, function (err, result) {
            if (err) {
                return next(err);
            }
            let resData = {
                curNav: '',
                showCrumb: false,
                user: {},
                meta: {},
                token: req.csrfToken()
            };
            if (req.session.user) {
                resData.user.userName = req.session.user.userDisplayName;
                resData.user.userEmail = req.session.user.userEmail;
            }
            const options = result.commonData.options;
            Object.assign(resData, result.commonData);

            resData.meta.title = util.getTitle([result.post.postTitle, options.site_name.optionValue]);
            resData.meta.description = result.post.postExcerpt || util.cutStr(util.filterHtmlTag(result.post.postContent), 140);
            resData.meta.keywords = result.post.postTitle + ',' + options.site_keywords.optionValue;
            resData.meta.author = options.site_author.optionValue;

            resData.post = result.post;
            resData.comments = result.comments;
            resData.util = util;
            resData.moment = moment;
            res.render(`${appConfig.pathViews}/front/pages/page`, resData);
        });
    },
    listByCategory: function (req, res, next) {
        let page = parseInt(req.params.page, 10) || 1;
        const category = req.params.category;
        let where = {
            postStatus: 'publish',
            postType: 'post'
        };
        let includeOpt;
        async.auto({
            commonData: (cb) => {
                getCommonData({
                    page: page,
                    from: 'category'
                }, cb);
            },
            subCategories: ['commonData', (result, cb) => {
                common.getSubCategoriesBySlug({
                    catData: result.commonData.categories.catData,
                    slug: category
                }, cb);
            }],
            setRelationshipWhere: ['subCategories', (result, cb) => {
                includeOpt = [{
                    model: models.TermRelationship,
                    attributes: ['objectId'],
                    where: {
                        termTaxonomyId: result.subCategories.subCatIds
                    }
                }];
                cb(null);
            }],
            postsCount: ['setRelationshipWhere', (result, cb) => {
                Post.count({
                    where,
                    include: includeOpt,
                    subQuery: false,
                    distinct: true
                }).then((count) => cb(null, count));
            }],
            posts: ['postsCount', (result, cb) => {
                page = (page > result.postsCount / 10 ? Math.ceil(result.postsCount / 10) : page) || 1;
                queryPosts({
                    page,
                    where,
                    includeOpt,
                    from: 'category'
                }, cb);
            }],
            comments: ['posts', (result, cb) => common.getCommentCountByPosts(result.posts, cb)]
        }, function (err, result) {
            if (err) {
                return next(err);
            }
            let resData = {
                curNav: result.subCategories.catPath[0].slug,
                showCrumb: true,
                user: {},
                meta: {}
            };
            const options = result.commonData.options;
            Object.assign(resData, result.commonData);

            resData.curPos = util.createCrumb(result.subCategories.catPath);

            resData.posts = result.posts;
            resData.posts.paginator = util.paginator(page, Math.ceil(result.postsCount / 10), pagesOut);
            resData.posts.linkUrl = '/category/' + category + '/page-';
            resData.posts.linkParam = '';
            resData.comments = result.comments;

            const curCat = result.subCategories.catPath[result.subCategories.catPath.length - 1].title;
            if (page > 1) {
                resData.meta.title = util.getTitle(['第' + page + '页', curCat, '分类目录', options.site_name.optionValue]);
            } else {
                resData.meta.title = util.getTitle([curCat, '分类目录', options.site_name.optionValue]);
            }

            resData.meta.description = '[' + curCat + ']' + (page > 1 ? '(第' + page + '页)' : '') + options.site_description.option_value;
            resData.meta.keywords = curCat + ',' + options.site_keywords.optionValue;
            resData.meta.author = options.site_author.optionValue;

            resData.util = util;
            resData.moment = moment;
            res.render(`${appConfig.pathViews}/front/pages/postList`, resData);
        });
    },
    listByTag: function (req, res, next) {
        let page = parseInt(req.params.page, 10) || 1;
        const tag = req.params.tag;
        let where = {
            postStatus: 'publish',
            postType: 'post'
        };
        let includeOpt = [{
            model: models.TermTaxonomy,
            attributes: ['taxonomyId'],
            where: {
                taxonomy: ['tag'],
                slug: tag
            }
        }];
        async.auto({
            commonData: (cb) => {
                getCommonData({
                    page: page,
                    from: 'tag'
                }, cb);
            },
            postsCount: (cb) => {
                Post.count({
                    where,
                    include: includeOpt
                }).then((count) => cb(null, count));
            },
            posts: ['postsCount', (result, cb) => {
                page = (page > result.postsCount / 10 ? Math.ceil(result.postsCount / 10) : page) || 1;
                queryPosts({
                    page,
                    where,
                    includeOpt,
                    from: 'tag'
                }, cb);
            }],
            comments: ['posts', (result, cb) => common.getCommentCountByPosts(result.posts, cb)]
        }, function (err, result) {
            if (err) {
                return next(err);
            }
            let resData = {
                curNav: 'index',
                showCrumb: true,
                user: {},
                meta: {}
            };
            const options = result.commonData.options;
            Object.assign(resData, result.commonData);

            const crumbData = [{
                'title': '标签',
                'tooltip': '标签',
                'url': '',
                'headerFlag': false
            }, {
                'title': tag,
                'tooltip': tag,
                'url': '/tag/' + tag,
                'headerFlag': true
            }];
            resData.curPos = util.createCrumb(crumbData);

            resData.posts = result.posts;
            resData.posts.paginator = util.paginator(page, Math.ceil(result.postsCount / 10), pagesOut);
            resData.posts.linkUrl = '/tag/' + tag + '/page-';
            resData.posts.linkParam = '';
            resData.comments = result.comments;

            if (page > 1) {
                resData.meta.title = util.getTitle(['第' + page + '页', tag, '标签', options.site_name.optionValue]);
            } else {
                resData.meta.title = util.getTitle([tag, '标签', options.site_name.optionValue]);
            }

            resData.meta.description = '[' + tag + ']' + (page > 1 ? '(第' + page + '页)' : '') + options.site_description.option_value;
            resData.meta.keywords = tag + ',' + options.site_keywords.optionValue;
            resData.meta.author = options.site_author.optionValue;

            resData.util = util;
            resData.moment = moment;
            res.render(`${appConfig.pathViews}/front/pages/postList`, resData);
        });
    },
    listByDate: function (req, res, next) {
        let page = parseInt(req.params.page, 10) || 1;
        let year = parseInt(req.params.year, 10) || new Date().getFullYear();
        let month = parseInt(req.params.month, 10);

        year = year.toString();
        month = month ? month < 10 ? '0' + month : month.toString() : '';
        const where = {
            postStatus: 'publish',
            postType: 'post',
            $and: [models.sequelize.where(models.sequelize.fn('date_format', models.sequelize.col('post_date'), month ? '%Y%m' : '%Y'), month ? year + month : year)]
        };

        async.auto({
            commonData: (cb) => {
                getCommonData({
                    page,
                    from: 'archive'
                }, cb);
            },
            postsCount: (cb) => {
                Post.count({
                    where
                }).then((data) => cb(null, data));
            },
            posts: ['postsCount', (result, cb) => {
                page = (page > result.postsCount / 10 ? Math.ceil(result.postsCount / 10) : page) || 1;
                queryPosts({
                    page,
                    where,
                    from: 'archive'
                }, cb);
            }],
            comments: ['posts', (result, cb) => common.getCommentCountByPosts(result.posts, cb)]
        }, (err, result) => {
            if (err) {
                return next(err);
            }
            let resData = {
                curNav: 'index',
                showCrumb: true,
                meta: {}
            };
            const options = result.commonData.options;
            Object.assign(resData, result.commonData);

            let crumbData = [{
                'title': '文章归档',
                'tooltip': '文章归档',
                'url': '',
                'headerFlag': false
            }, {
                'title': `${year}年`,
                'tooltip': `${year}年`,
                'url': '/archive/' + year,
                'headerFlag': !month
            }];
            if (month) {
                crumbData.push({
                    'title': `${parseInt(month, 10)}月`,
                    'tooltip': `${year}年${month}月`,
                    'url': `/archive/${year}/${month}`,
                    'headerFlag': true
                });
            }
            resData.curPos = util.createCrumb(crumbData);

            resData.posts = result.posts;
            resData.posts.paginator = util.paginator(page, Math.ceil(result.postsCount / 10), pagesOut);
            resData.posts.linkUrl = `/archive/${year}${month ? '/' + month : ''}/page-`;
            resData.posts.linkParam = '';
            resData.comments = result.comments;

            const title = `${year}年${month ? month + '月' : ''}`;
            if (page > 1) {
                resData.meta.title = util.getTitle(['第' + page + '页', title, '文章归档', options.site_name.optionValue]);
            } else {
                resData.meta.title = util.getTitle([title, '文章归档', options.site_name.optionValue]);
            }

            resData.meta.description = `[${title}]` + (page > 1 ? '(第' + page + '页)' : '') + options.site_description.optionValue;
            resData.meta.keywords = options.site_keywords.optionValue;
            resData.meta.author = options.site_author.optionValue;

            resData.util = util;
            resData.moment = moment;
            res.render(`${appConfig.pathViews}/front/pages/postList`, resData);
        });
    },
    listEdit: function (req, res, next) {
        let page = parseInt(req.params.page, 10) || 1;
        let where = {};
        let titleArr = [];
        let paramArr = [];
        let from = 'admin';

        if (req.query.status) {
            if (req.query.status === 'draft') {
                where.postStatus = ['draft', 'auto-draft'];
            } else {
                where.postStatus = req.query.status;
            }
            paramArr.push(`status=${req.query.status}`);
            titleArr.push(formatter.postStatus(req.query.status) || req.query.status, '状态');
        } else {
            where.postStatus = ['publish', 'private', 'draft', 'auto-draft', 'trash'];
        }
        if (req.query.author) {
            where.postAuthor = req.query.author;
            paramArr.push(`author=${req.query.author}`);
            titleArr.push('作者');
        }
        if (req.query.date) {
            where.$and = [models.sequelize.where(models.sequelize.fn('date_format', models.sequelize.col('post_date'), '%Y/%m'), '=', req.query.date)];
            paramArr.push(`date=${req.query.date}`);
            titleArr.push(req.query.date, '日期');
        }
        if (req.query.keyword) {
            where.$or = [{
                postTitle: {
                    $like: `%${req.query.keyword}%`
                }
            }, {
                postContent: {
                    $like: `%${req.query.keyword}%`
                }
            }, {
                postExcerpt: {
                    $like: `%${req.query.keyword}%`
                }
            }];
            paramArr.push(`keyword=${req.query.keyword}`);
            titleArr.push(req.query.keyword, '搜索');
        }
        let includeOpt = [];
        let tagWhere;
        if (req.query.tag) {
            from = 'tag';
            tagWhere = {
                taxonomy: ['tag'],
                slug: req.query.tag
            };
            includeOpt.push({
                model: models.TermTaxonomy,
                attributes: ['taxonomyId'],
                where: tagWhere
            });
            paramArr.push(`tag=${req.query.tag}`);
            titleArr.push(req.query.tag, '标签');
        }
        where.postType = req.query.type === 'page' ? 'page' : 'post';
        paramArr.push(`type=${where.postType}`);

        async.auto({
            options: common.getInitOptions,
            archiveDates: (cb) => {
                common.archiveDates(cb, where.postType);
            },
            categories: common.getCategoryTree.bind(common),
            subCategories: ['categories', (result, cb) => {
                if (req.query.category) {
                    from = 'category';
                    paramArr.push(`category=${req.query.category}`);

                    common.getSubCategoriesBySlug({
                        catData: result.categories.catData,
                        slug: req.query.category
                    }, (err, data) => {
                        if (err) {
                            return cb(err);
                        }
                        includeOpt.push({
                            model: models.TermRelationship,
                            attributes: ['objectId'],
                            where: {
                                termTaxonomyId: data.subCatIds
                            }
                        });
                        titleArr.push(data.catRoot.name, '分类');
                        cb(null);
                    });
                } else {
                    cb(null);
                }
            }],
            postsCount: ['subCategories', (result, cb) => {
                Post.count({
                    where,
                    include: includeOpt
                }).then((data) => cb(null, data));
            }],
            posts: ['postsCount', (result, cb) => {
                page = (page > result.postsCount / 10 ? Math.ceil(result.postsCount / 10) : page) || 1;
                queryPosts({
                    page,
                    where,
                    from,
                    includeOpt
                }, cb);
            }],
            comments: ['posts', (result, cb) => common.getCommentCountByPosts(result.posts, cb)],
            typeCount: (cb) => {
                Post.findAll({
                    attributes: [
                        'postStatus',
                        'postType',
                        ['count(1)', 'count']
                    ],
                    where: {
                        postType: where.postType,
                        postStatus: ['publish', 'private', 'draft', 'auto-draft', 'trash']
                    },
                    group: ['postStatus']
                }).then((data) => cb(null, data));
            }
        }, function (err, result) {
            if (err) {
                return next(err);
            }
            let resData = {
                meta: {},
                type: where.postType,
                page: where.postType,
                archiveDates: result.archiveDates,
                categories: result.categories,
                options: result.options,
                count: {
                    all: 0,
                    publish: 0,
                    private: 0,
                    draft: 0,
                    trash: 0
                },
                posts: result.posts,
                comments: result.comments,
                util,
                formatter,
                moment
            };
            resData.paginator = util.paginator(page, Math.ceil(result.postsCount / 10), pagesOut);
            resData.paginator.linkUrl = '/admin/post/page-';
            resData.paginator.linkParam = paramArr.length > 0 ? '?' + paramArr.join('&') : '';
            resData.paginator.pageLimit = 10;
            resData.paginator.total = result.postsCount;

            if (page > 1) {
                resData.meta.title = util.getTitle(titleArr.concat(['第' + page + '页', where.postType === 'page' ? '页面列表' : '文章列表', '管理后台', result.options.site_name.optionValue]));
            } else {
                resData.meta.title = util.getTitle(titleArr.concat([where.postType === 'page' ? '页面列表' : '文章列表', '管理后台', result.options.site_name.optionValue]));
            }

            result.typeCount.forEach((item) => {
                resData.count.all += item.get('count');

                switch (item.postStatus) {
                    case 'publish':
                        resData.count.publish += item.get('count');
                        break;
                    case 'private':
                        resData.count.private += item.get('count');
                        break;
                    case 'draft':
                        resData.count.draft += item.get('count');
                        break;
                    case 'auto-draft':
                        resData.count.draft += item.get('count');
                        break;
                    case 'trash':
                        resData.count.trash += item.get('count');
                        break;
                    default:
                }
            });

            resData.curCategory = req.query.category;
            resData.curStatus = req.query.status || 'all';
            resData.curDate = req.query.date;
            resData.curKeyword = req.query.keyword;
            res.render(`${appConfig.pathViews}/admin/pages/postList`, resData);
        });
    },
    editPost: function (req, res, next) {
        const postId = req.params.postId;
        let tasks = {
            categories: common.getCategoryTree.bind(common),
            options: common.getInitOptions
        };
        if (postId) {
            if (!idReg.test(postId)) {
                return util.catchError({
                    status: 404,
                    code: 404,
                    message: '文章不存在'
                }, next);
            }
            let includeOpt = [{
                model: User,
                attributes: ['userDisplayName']
            }];
            if (req.query.type !== 'page') {
                includeOpt.push({
                    model: models.TermTaxonomy,
                    attributes: ['taxonomyId', 'taxonomy', 'name', 'slug', 'description', 'parent', 'termOrder', 'count'],
                    where: {
                        taxonomy: ['post', 'tag']
                    }
                });
            }
            tasks.post = (cb) => {
                Post.findById(postId, {
                    attributes: [
                        'postId', 'postTitle', 'postDate', 'postContent', 'postExcerpt', 'postStatus', 'postType', 'postPassword',
                        'commentFlag', 'postOriginal', 'postName', 'postAuthor', 'postModified', 'postCreated', 'postGuid', 'commentCount', 'postViewCount'],
                    include: includeOpt
                }).then(function (post) {
                    if (!post || !post.postId) {
                        logger.error(util.getErrorLog({
                            req: req,
                            funcName: 'editPost',
                            funcParam: {
                                postId: postId
                            },
                            msg: 'Post Not Exist.'
                        }));
                        return cb(util.catchError({
                            status: 404,
                            code: 404,
                            message: 'Page Not Found.'
                        }));
                    }
                    cb(null, post);
                });
            };
        }
        async.parallel(tasks, function (err, result) {
            if (err) {
                return next(err);
            }
            let resData = {
                categories: result.categories,
                options: result.options,
                meta: {},
                token: req.csrfToken(),
                util,
                moment
            };
            let title;
            if (postId) {
                title = result.post.postType === 'page' ? '编辑页面' : '编辑文章';
                resData.page = result.post.postType;
            } else {
                title = req.query.type === 'page' ? '撰写新页面' : '撰写新文章';
                resData.page = req.query.type === 'page' ? 'page' : 'post';
            }
            resData.title = title;
            resData.meta.title = util.getTitle([title, '管理后台', result.options.site_name.optionValue]);

            resData.post = result.post || {
                postStatus: 'publish',
                postOriginal: 1,
                commentFlag: 'verify'
            };
            resData.postCategories = [];
            resData.postTags = '';
            let tagArr = [];
            if (result.post && result.post.TermTaxonomies) {
                result.post.TermTaxonomies.forEach((v) => {
                    if (v.taxonomy === 'tag') {
                        tagArr.push(v.name);
                    } else if (v.taxonomy === 'post') {
                        resData.postCategories.push(v.taxonomyId);
                    }
                });
                resData.postTags = tagArr.join(',');
            }
            res.render(`${appConfig.pathViews}/admin/pages/postForm`, resData);
        });
    },
    savePost: function (req, res, next) {
        const param = req.body;
        const type = req.query.type !== 'page' ? 'post' : 'page';
        const nowTime = new Date();
        let postId = util.trim(xss.sanitize(param.postId));
        postId = idReg.test(postId) ? postId : '';
        const newPostId = postId || util.getUuid();

        let data = {
            postTitle: util.trim(xss.sanitize(param.postTitle)),
            postContent: util.trim(param.postContent),
            postExcerpt: util.trim(xss.sanitize(param.postExcerpt)),
            postGuid: util.trim(xss.sanitize(param.postGuid)) || '/post/' + newPostId,
            postAuthor: req.session.user.userId,
            postStatus: param.postStatus,
            postPassword: util.trim(param.postPassword),
            postOriginal: param.postOriginal,
            commentFlag: util.trim(param.commentFlag),
            postDate: param.postDate ? new Date(+moment(param.postDate)) : nowTime,
            postType: type
        };
        let postCategory = util.trim(xss.sanitize(param.postCategory));
        if (postCategory === '') {
            postCategory = [];
        } else if (typeof postCategory === 'string') {
            postCategory = postCategory.split(/[,\s]/i);
        } else {
            postCategory = util.isArray(postCategory) ? postCategory : [];
        }
        let postTag = util.trim(xss.sanitize(param.postTag));
        if (postTag === '') {
            postTag = [];
        } else if (typeof postTag === 'string') {
            postTag = postTag.split(/[,\s]/i);
        } else {
            postTag = util.isArray(postTag) ? postTag : [];
        }

        const checkResult = checkPostFields({
            data,
            type,
            postCategory,
            postTag
        });
        if (checkResult !== true) {
            return next(checkResult);
        }
        if (data.postStatus === 'password') {
            data.postStatus = 'publish';
        } else {
            data.postPassword = '';
        }

        models.sequelize.transaction(function (t) {
            let tasks = {
                deleteCatRel: function (cb) {
                    if (type !== 'post' || !postId) {
                        return cb(null);
                    }
                    models.TermRelationship.destroy({
                        where: {
                            objectId: postId
                        },
                        transaction: t
                    }).then((data) => cb(null, data));
                },
                checkGuid: function (cb) {
                    let where = {
                        postGuid: data.postGuid
                    };
                    if (postId) {
                        where.postId = {
                            $ne: postId
                        };
                    }
                    Post.count({
                        where
                    }).then((count) => cb(null, count));
                },
                post: ['checkGuid', function (result, cb) {
                    if (result.checkGuid > 0) {
                        return cb('URL已存在');
                    }
                    data.postDateGmt = data.postDate;
                    if (!postId) {
                        data.postId = newPostId;
                        data.postModifiedGmt = nowTime;
                        Post.create(data, {
                            transaction: t
                        }).then((post) => cb(null, post));
                    } else {
                        Post.update(data, {
                            where: {
                                postId
                            },
                            transaction: t
                        }).then((post) => cb(null, post));
                    }
                }]
            };
            // 对于异步的循环，若中途其他操作出现报错，将触发rollback，但循环并未中断，从而导致事务执行报错，因此需要强制加入依赖关系，改为顺序执行
            if (type !== 'page' && type !== 'attachment') {
                tasks.category = ['deleteCatRel', 'post', (result, cb) => {
                    async.times(postCategory.length, (i, nextFn) => {
                        if (postCategory[i]) {
                            models.TermRelationship.create({
                                objectId: newPostId,
                                termTaxonomyId: postCategory[i]
                            }, {
                                transaction: t
                            }).then((rel) => nextFn(null, rel));
                        } else {
                            nextFn(null);
                        }
                    }, (err, categories) => {
                        cb(err, categories);
                    });
                }];
                tasks.tag = ['deleteCatRel', 'post', (result, cb) => {
                    async.times(postTag.length, (i, nextFn) => {
                        const tag = postTag[i].trim();
                        if (tag) {
                            async.auto({
                                taxonomy: function (innerCb) {
                                    models.TermTaxonomy.findAll({
                                        attributes: ['taxonomyId'],
                                        where: {
                                            slug: tag
                                        }
                                    }).then((tags) => {
                                        if (tags.length > 0) {// 已存在标签
                                            return innerCb(null, tags[0].taxonomyId);
                                        }
                                        const taxonomyId = util.getUuid();
                                        // sequelize对事务中的created、modified处理有bug，会保存为invalid date，因此取消默认的行为，改为显式赋值
                                        models.TermTaxonomy.create({
                                            taxonomyId: taxonomyId,
                                            taxonomy: 'tag',
                                            name: tag,
                                            slug: tag,
                                            description: tag,
                                            count: 1,
                                            created: nowTime,
                                            modified: nowTime
                                        }, {
                                            transaction: t
                                        }).then((taxonomy) => innerCb(null, taxonomyId));
                                    });
                                },
                                relationship: ['taxonomy', function (innerResult, innerCb) {
                                    models.TermRelationship.create({
                                        objectId: newPostId,
                                        termTaxonomyId: innerResult.taxonomy
                                    }, {
                                        transaction: t
                                    }).then((rel) => innerCb(null, rel));
                                }]
                            }, function (err, tags) {
                                if (err) {
                                    return nextFn(err);
                                }
                                nextFn(null, tags);
                            });
                        } else {
                            nextFn(null);
                        }
                    }, (err, tags) => {
                        cb(err, tags);
                    });
                }];
            }
            // 需要返回promise实例
            return new Promise((resolve, reject) => {
                async.auto(tasks, function (err, result) {
                    if (err) {
                        reject(new Error(err));
                    } else {
                        resolve(result);
                    }
                });
            });
        }).then(() => {
            const referer = req.session.referer;
            delete req.session.referer;
            res.set('Content-type', 'application/json');
            res.send({
                status: 200,
                code: 0,
                message: null,
                data: {
                    url: referer || '/admin/post?type=' + type
                }
            });
        }, (err) => {
            next({
                status: 200,
                code: 500,
                message: err.message || err
            });
        });
    },
    listMedia: function (req, res, next) {
        let page = parseInt(req.params.page, 10) || 1;
        let where = {};
        let titleArr = [];
        let paramArr = [];
        let from = 'admin';

        if (req.query.status) {
            if (req.query.status === 'draft') {
                where.postStatus = ['draft', 'auto-draft'];
            } else {
                where.postStatus = req.query.status;
            }
            paramArr.push(`status=${req.query.status}`);
            titleArr.push(formatter.postStatus(req.query.status) || req.query.status, '状态');
        } else {
            where.postStatus = ['publish', 'private', 'draft', 'auto-draft', 'trash'];
        }
        if (req.query.author) {
            where.postAuthor = req.query.author;
            paramArr.push(`author=${req.query.author}`);
            titleArr.push('作者');
        }
        if (req.query.date) {
            where.$and = [models.sequelize.where(models.sequelize.fn('date_format', models.sequelize.col('post_date'), '%Y/%m'), '=', req.query.date)];
            paramArr.push(`date=${req.query.date}`);
            titleArr.push(req.query.date, '日期');
        }
        if (req.query.keyword) {
            where.$or = [{
                postTitle: {
                    $like: `%${req.query.keyword}%`
                }
            }, {
                postContent: {
                    $like: `%${req.query.keyword}%`
                }
            }, {
                postExcerpt: {
                    $like: `%${req.query.keyword}%`
                }
            }];
            paramArr.push(`keyword=${req.query.keyword}`);
            titleArr.push(req.query.keyword, '搜索');
        }
        where.postType = 'attachment';
        paramArr.push(`type=${where.postType}`);

        async.auto({
            options: common.getInitOptions,
            archiveDates: (cb) => {
                common.archiveDates(cb, where.postType);
            },
            postsCount: (cb) => {
                Post.count({
                    where
                }).then((data) => cb(null, data));
            },
            posts: ['postsCount', (result, cb) => {
                page = (page > result.postsCount / 10 ? Math.ceil(result.postsCount / 10) : page) || 1;
                queryPosts({
                    page,
                    where,
                    from
                }, cb);
            }],
            typeCount: (cb) => {
                Post.findAll({
                    attributes: [
                        'postStatus',
                        'postType',
                        ['count(1)', 'count']
                    ],
                    where: {
                        postType: where.postType,
                        postStatus: ['publish', 'private', 'draft', 'auto-draft', 'trash']
                    },
                    group: ['postStatus']
                }).then((data) => cb(null, data));
            }
        }, function (err, result) {
            if (err) {
                return next(err);
            }
            let resData = {
                meta: {},
                type: where.postType,
                page: where.postType,
                archiveDates: result.archiveDates,
                options: result.options,
                count: {
                    all: 0,
                    publish: 0,
                    private: 0,
                    draft: 0,
                    trash: 0
                },
                posts: result.posts,
                util,
                formatter,
                moment
            };
            resData.paginator = util.paginator(page, Math.ceil(result.postsCount / 10), pagesOut);
            resData.paginator.linkUrl = '/admin/media/page-';
            resData.paginator.linkParam = paramArr.length > 0 ? '?' + paramArr.join('&') : '';
            resData.paginator.pageLimit = 10;
            resData.paginator.total = result.postsCount;

            if (page > 1) {
                resData.meta.title = util.getTitle(titleArr.concat(['第' + page + '页', '多媒体列表', '管理后台', result.options.site_name.optionValue]));
            } else {
                resData.meta.title = util.getTitle(titleArr.concat(['多媒体列表', '管理后台', result.options.site_name.optionValue]));
            }

            result.typeCount.forEach((item) => {
                resData.count.all += item.get('count');

                switch (item.postStatus) {
                    case 'publish':
                        resData.count.publish += item.get('count');
                        break;
                    case 'private':
                        resData.count.private += item.get('count');
                        break;
                    case 'draft':
                        resData.count.draft += item.get('count');
                        break;
                    case 'auto-draft':
                        resData.count.draft += item.get('count');
                        break;
                    case 'trash':
                        resData.count.trash += item.get('count');
                        break;
                    default:
                }
            });

            resData.curStatus = req.query.status || 'all';
            resData.curDate = req.query.date;
            resData.curKeyword = req.query.keyword;
            res.render(`${appConfig.pathViews}/admin/pages/mediaList`, resData);
        });
    },
    createMedia: function (req, res, next) {
        common.getInitOptions((err, options) => {
            if (err) {
                return next(err);
            }
            let resData = {
                meta: {
                    title: util.getTitle(['上传新媒体文件', '管理后台', options.site_name.optionValue])
                },
                page: 'media',
                token: req.csrfToken(),
                options
            };
            res.render(`${appConfig.pathViews}/admin/pages/mediaForm`, resData);
        });
    },
    uploadFile: function (req, res, next) {
        const form = new formidable.IncomingForm();
        const now = moment();
        const curYear = now.format('YYYY');
        const curMonth = now.format('MM');
        const sizeLimit = 500;
        let yearPath;
        let uploadPath;

        yearPath = path.join(__dirname, '..', 'public', 'upload', curYear);
        uploadPath = path.join(yearPath, curMonth);
        if (!fs.existsSync(yearPath)) {
            fs.mkdirSync(yearPath);
        }
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath);
        }
        form.uploadDir = uploadPath;
        form.keepExtensions = true;
        form.maxFieldsSize = sizeLimit * 1024 * 1024;

        form.on('error', function (err) {
            logger.error(util.getErrorLog({
                req: req,
                funcName: 'uploadFile',
                funcParam: {
                    uploadPath: uploadPath
                },
                msg: err
            }));
        });
        form.parse(req, function (err, fields, files) {
            let fileExt = files.mediafile.name.split('.');
            if (fileExt.length > 1) {
                fileExt = '.' + fileExt.pop();
            } else {
                fileExt = '';
            }
            const filename = util.getUuid() + fileExt;
            const filepath = path.join(uploadPath, filename);
            const nowTime = new Date();
            let fileData = {};
            fs.renameSync(files.mediafile.path, filepath);

            fileData.postTitle = fileData.postExcerpt = fileData.postContent = xss.sanitize(files.mediafile.name);
            fileData.postAuthor = req.session.user.userId;
            fileData.postStatus = 'publish';
            fileData.postType = 'attachment';
            fileData.postId = util.getUuid();
            fileData.postGuid = '/static/' + curYear + '/' + curMonth + '/' + filename;
            fileData.postModifiedGmt = fileData.postDateGmt = fileData.postDate = nowTime;

            models.sequelize.transaction(function (t) {
                let tasks = {
                    checkGuid: function (cb) {
                        let where = {
                            postGuid: fileData.postGuid
                        };
                        Post.count({
                            where
                        }).then((count) => cb(null, count));
                    },
                    post: ['checkGuid', function (result, cb) {
                        if (result.checkGuid > 0) {
                            return cb('URL已存在');
                        }
                        Post.create(fileData, {
                            transaction: t
                        }).then((post) => cb(null, post));
                    }]
                };
                // 需要返回promise实例
                return new Promise((resolve, reject) => {
                    async.auto(tasks, function (err, result) {
                        if (err) {
                            reject(new Error(err));
                        } else {
                            resolve(result);
                        }
                    });
                });
            }).then(() => {
                delete req.session.referer;
                res.set('Content-type', 'application/json');
                res.send({
                    status: 200,
                    code: 0,
                    message: null,
                    data: {
                        url: '/admin/media'
                    }
                });
            }, (err) => {
                next({
                    status: 200,
                    code: 500,
                    message: err.message || err
                });
            });

            logger.info(util.getInfoLog({
                req: req,
                funcName: 'uploadFile',
                funcParam: {
                    uploadPath: uploadPath,
                    filename: files.mediafile.name
                },
                msg: 'Upload file: ' + filename
            }));
        });
    }
};
