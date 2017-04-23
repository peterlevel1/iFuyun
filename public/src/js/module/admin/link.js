/*global $*/
'use strict';
require('../../vendor/jquery-1.11.0.min');

$(function () {
    //链接列表
    $('.btn-delete').on('click', function () {
        var $that = $(this);
        $.ajax({
            type: 'post',
            url: '/admin/link/remove',
            data: {
                linkId: $that.attr('data-id')
            },
            headers: {
                'X-CSRF-Token': $('#csrfToken').val()
            },
            dataType: 'json',
            success: function (d) {
                if (d.code === 0) {
                    // location.href = d.data.url;
                    window.location.reload();
                } else {
                    alert(d.message);
                }
            },
            error: function () {
                return false;
            }
        });
        return false;
    });

    //链接表单
    $('#cat-name').focus();
    $('#form-link').on('submit', function () {
        var $that = $(this);
        $.ajax({
            type: 'post',
            url: $that.attr('action'),
            data: $that.serialize(),
            dataType: 'json',
            success: function (d) {
                if (d.code === 0) {
                    location.href = d.data.url;
                } else {
                    $('#csrfToken').val(d.token);
                    alert(d.message);
                }
            },
            error: function () {
                return false;
            }
        });
        return false;
    });
});